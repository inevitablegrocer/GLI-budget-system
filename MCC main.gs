/**
 * main.gs
 * GLI Budget Pacing System
 *
 * Runs in: MCC Ads Script project only
 * Entry point: main() — called by Google Ads Scripts on schedule
 *
 * Execution order per client account:
 *   1. Load system config from Config Workbook (once per run)
 *   2. Iterate over all active MCC child accounts
 *   3. For each account that matches a configured client:
 *      a. Select the child account via AdsManagerApp
 *      b. Build date context
 *      c. Collect campaign data + parse names (dataCollection + campaignParser)
 *      d. Calculate recommended budgets (budget.calculateRecommendedBudgets)
 *      e. Validate pacing alignment (budget.validateBudgetAlignment)
 *         — this also reads approved budgets fresh from the Budget Workbook,
 *           so client approval state is always current without a separate sync call
 *      f. Write results to the Campaigns tab (spreadsheetUpdater)
 *      g. Send alert email if any warning/critical campaigns (alerter)
 *   4. Log performance summary
 *
 * NOTE — syncApprovalsToAgencySheet:
 *   The HANDOFF spec mentions calling syncApprovalsToAgencySheet at the start
 *   of each account run. That function lives in budgetInput.gs (Sheets-only
 *   project) and is not available here. It is not needed: the MCC script reads
 *   approved budgets directly from the Budget Workbook via _readApprovedBudgets()
 *   inside budget.validateBudgetAlignment(), which always reflects the latest
 *   state of the sheet. Approval syncing from client → agency sheet is a
 *   separate manual or time-triggered workflow in the Budget Workbook project.
 *
 * Dependencies (shared global scope in MCC project):
 *   - configManager      (config.gs)
 *   - dataCollection     (dataCollection.gs)
 *   - campaignParser     (campaignParser.gs)
 *   - budget             (budget.gs)
 *   - spreadsheetUpdater (spreadsheetUpdater.gs)
 *   - alerter            (alerter.gs)
 *   - utils              (utils.gs)
 *   - AdsManagerApp, AdsApp, SpreadsheetApp (Google globals)
 */

// ---------------------------------------------------------------------------
// main — entry point
// ---------------------------------------------------------------------------

function main() {
  const startTime = new Date();
  const metrics   = utils.initializeMetrics();

  utils.log('===== GLI Budget Pacing System — run started =====', utils.LOG_LEVELS.INFO);

  // ── 1. Load configuration ─────────────────────────────────────────────────
  let systemConfig;
  try {
    systemConfig = configManager.loadConfiguration();
  } catch (error) {
    utils.logError('FATAL: could not load system configuration', error);
    return;
  }

  if (Object.keys(systemConfig.clients).length === 0) {
    utils.log('No active clients found in config — exiting', utils.LOG_LEVELS.WARNING);
    return;
  }

  utils.setLogLevel(systemConfig.execution.LOG_LEVEL || utils.LOG_LEVELS.INFO);

  // ── 2. Build dates object once — shared across all accounts this run ───────
  const dates = budget.buildDatesObject();
  utils.log(
    `Date context: ${dates.monthLabel}  day ${dates.dayOfMonth}/${dates.daysInMonth}  ${dates.daysRemaining} days remaining`,
    utils.LOG_LEVELS.INFO
  );

  // ── 3. Iterate over MCC child accounts ────────────────────────────────────
  const accountIterator = AdsManagerApp.accounts().get();
  metrics.totalAccounts = accountIterator.totalNumEntities();

  while (accountIterator.hasNext()) {
    // Enforce runtime limit to avoid hitting the 30-minute Ads Scripts ceiling
    const elapsedMinutes = (new Date() - startTime) / 60000;
    if (elapsedMinutes >= systemConfig.execution.MAX_RUNTIME_MINUTES) {
      utils.log(
        `Approaching runtime limit (${systemConfig.execution.MAX_RUNTIME_MINUTES} min) — stopping early`,
        utils.LOG_LEVELS.WARNING
      );
      metrics.timeoutTerminated = true;
      break;
    }

    const account   = accountIterator.next();
    const accountId = configManager.normalizeAccountId(account.getCustomerId());

    // Skip accounts not in config
    const clientConfig = configManager.getClientConfig(accountId, systemConfig);
    if (!clientConfig) {
      utils.log(`Account ${accountId} not in config — skipping`, utils.LOG_LEVELS.DEBUG);
      metrics.skippedAccounts++;
      continue;
    }

    // Validate config before doing any work
    const validation = configManager.validateClientConfig(clientConfig);
    if (!validation.success) {
      utils.log(
        `Skipping ${clientConfig.name} (${accountId}): config errors — ${validation.errors.join(', ')}`,
        utils.LOG_LEVELS.WARNING
      );
      metrics.skippedAccounts++;
      continue;
    }

    _processAccount(account, clientConfig, dates, metrics, startTime);
  }

  // ── 4. Summary ────────────────────────────────────────────────────────────
  utils.logPerformanceSummary(metrics, startTime);
  utils.log('===== GLI Budget Pacing System — run complete =====', utils.LOG_LEVELS.INFO);
}

// ---------------------------------------------------------------------------
// _processAccount — per-account logic
// ---------------------------------------------------------------------------

/**
 * Runs the full pacing pipeline for a single client account.
 * Errors are caught and recorded in metrics without aborting the outer loop.
 *
 * @param {AdsAccount} account       MCC child account object
 * @param {Object}     clientConfig  From configManager.getClientConfig()
 * @param {Object}     dates         From budget.buildDatesObject()
 * @param {Object}     metrics       Shared metrics object (mutated)
 * @param {Date}       startTime     Overall run start time
 */
function _processAccount(account, clientConfig, dates, metrics, startTime) {
  const accountStart = new Date();
  utils.log(`\n── Processing: ${clientConfig.name} (${clientConfig.accountId}) ──`, utils.LOG_LEVELS.INFO);

  try {
    // Select this child account so AdsApp queries run against it
    AdsManagerApp.select(account);

    // ── a. Collect campaign data ───────────────────────────────────────────
    // dataCollection internally calls campaignParser.parseCampaignNames(),
    // so each campaign object arrives with .location, .campaignType, etc.
    const campaigns = dataCollection.collectCampaignData(clientConfig, dates);

    if (campaigns.length === 0) {
      utils.log(`No campaigns found for ${clientConfig.name} — skipping`, utils.LOG_LEVELS.WARNING);
      metrics.skippedAccounts++;
      return;
    }

    utils.log(`Collected ${campaigns.length} campaigns`, utils.LOG_LEVELS.INFO);

    // ── b. Calculate recommended budgets ─────────────────────────────────
    // Reads Budget Input sheet; used for context/logging — pacing math
    // uses approved budgets read inside validateBudgetAlignment.
    const recommendedBudgets = budget.calculateRecommendedBudgets(clientConfig, dates);
    utils.log(`Calculated recommended budgets for ${Object.keys(recommendedBudgets).length} rows`, utils.LOG_LEVELS.INFO);

    // ── c. Validate pacing alignment ──────────────────────────────────────
    // Reads Approved Budget column from Budget Input sheet directly.
    const alignment = budget.validateBudgetAlignment(clientConfig, campaigns, dates);

    utils.log(
      `Pacing summary: ok=${alignment.summary.ok} warning=${alignment.summary.warning} ` +
      `critical=${alignment.summary.critical} skipped=${alignment.summary.skipped}`,
      utils.LOG_LEVELS.INFO
    );

    // ── d. Write to Campaigns tab ─────────────────────────────────────────
    spreadsheetUpdater.updateCampaignsTab(clientConfig, alignment.results, dates);

    // ── e. Send alert email ───────────────────────────────────────────────
    if (alignment.hasWarning || alignment.hasCritical) {
      const alertSummary = alerter.buildAlertSummary(alignment.results);
      alerter.sendAlertEmail(clientConfig, alertSummary);
    }

    // ── Record success ─────────────────────────────────────────────────────
    const elapsed = (new Date() - accountStart) / 1000;
    metrics.processedAccounts++;
    metrics.totalProcessingTime += elapsed;
    utils.log(`Finished ${clientConfig.name} in ${elapsed.toFixed(1)}s`, utils.LOG_LEVELS.INFO);

  } catch (error) {
    utils.logError(`Error processing ${clientConfig.name} (${clientConfig.accountId})`, error);
    metrics.failedAccounts++;
    metrics.errorDetails.push({
      accountName: clientConfig.name,
      accountId:   clientConfig.accountId,
      error:       error.message || String(error),
    });
  }
}
