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
 *      b. Collect campaign data + parse names (dataCollection + campaignParser)
 *      c. Calculate recommended budgets (budget.calculateRecommendedBudgets)
 *      d. Validate pacing alignment (budget.validateBudgetAlignment)
 *      e. Write results to the Campaigns tab (spreadsheetUpdater)  [skipped in TEST_MODE]
 *      f. Send alert email if any warning/critical campaigns       [skipped in TEST_MODE]
 *   4. Log performance summary
 *
 * ── TEST MODE ────────────────────────────────────────────────────────────────
 * Set TEST_MODE = true to run safely without writing to any sheet or sending
 * any email. The log will show config load results, campaign parse output, and
 * pacing calculations for the first TEST_LOG_CAMPAIGNS campaigns.
 *
 * Set TEST_ACCOUNT_ID to a specific CID to process only that one account.
 * Leave it blank ('') to process the first matching client found.
 *
 * When everything looks correct in the logs, set TEST_MODE = false to go live.
 * ─────────────────────────────────────────────────────────────────────────────
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
// !! TEST FLAGS — read before running !!
// ---------------------------------------------------------------------------

/**
 * When true:
 *   - No sheet writes (spreadsheetUpdater is skipped entirely)
 *   - No emails sent
 *   - Detailed per-campaign log output for the first TEST_LOG_CAMPAIGNS campaigns
 *   - Only processes the account matching TEST_ACCOUNT_ID (or first client if blank)
 *
 * Set to false for scheduled production runs.
 */
const TEST_MODE = true;

/**
 * CID of the account to process in test mode. e.g. '148-675-4917'
 * Leave blank ('') to use the first client found in config.
 */
const TEST_ACCOUNT_ID = '148-675-4917';

/**
 * Number of campaigns to log in detail during test mode.
 * Keep this small to avoid log truncation.
 */
const TEST_LOG_CAMPAIGNS = 5;

// ---------------------------------------------------------------------------
// main — entry point
// ---------------------------------------------------------------------------

function main() {
  const startTime = new Date();
  const metrics   = utils.initializeMetrics();

  utils.log(
    `===== GLI Budget Pacing System — run started${TEST_MODE ? ' [TEST MODE]' : ''} =====`,
    utils.LOG_LEVELS.INFO
  );

  if (TEST_MODE) {
    utils.log(
      `TEST MODE: no sheet writes, no emails. Account filter: "${TEST_ACCOUNT_ID || 'first client'}"`,
      utils.LOG_LEVELS.INFO
    );
  }

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

  // In test mode, log a full summary of what was loaded from config
  if (TEST_MODE) {
    _logConfigSummary(systemConfig);
  }

  utils.setLogLevel(systemConfig.execution.LOG_LEVEL || utils.LOG_LEVELS.INFO);

  // ── 2. Build dates object once ────────────────────────────────────────────
  const dates = budget.buildDatesObject();
  utils.log(
    `Date context: ${dates.monthLabel}  day ${dates.dayOfMonth}/${dates.daysInMonth}  ${dates.daysRemaining} days remaining`,
    utils.LOG_LEVELS.INFO
  );

  // ── 3. Iterate over MCC child accounts ────────────────────────────────────
  const accountIterator = AdsManagerApp.accounts().get();
  metrics.totalAccounts = accountIterator.totalNumEntities();

  let testModeProcessed = false;

  while (accountIterator.hasNext()) {
    // Enforce runtime limit
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

    // Test mode account filter
    if (TEST_MODE) {
      const targetId     = TEST_ACCOUNT_ID ? configManager.normalizeAccountId(TEST_ACCOUNT_ID) : null;
      const clientConfig = configManager.getClientConfig(accountId, systemConfig);

      if (targetId && accountId !== targetId) continue;
      if (!targetId && (!clientConfig || testModeProcessed)) {
        if (testModeProcessed) break;
        if (!clientConfig) continue;
      }

      testModeProcessed = true;
    }

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

    _processAccount(account, clientConfig, dates, metrics);

    if (TEST_MODE) break;
  }

  // ── 4. Summary ────────────────────────────────────────────────────────────
  utils.logPerformanceSummary(metrics, startTime);
  utils.log(
    `===== GLI Budget Pacing System — run complete${TEST_MODE ? ' [TEST MODE]' : ''} =====`,
    utils.LOG_LEVELS.INFO
  );
}

// ---------------------------------------------------------------------------
// _processAccount — per-account logic
// ---------------------------------------------------------------------------

/**
 * Runs the full pacing pipeline for a single client account.
 * In TEST_MODE, skips all sheet writes and emails, and logs campaign detail.
 *
 * @param {AdsAccount} account       MCC child account object
 * @param {Object}     clientConfig  From configManager.getClientConfig()
 * @param {Object}     dates         From budget.buildDatesObject()
 * @param {Object}     metrics       Shared metrics object (mutated)
 */
function _processAccount(account, clientConfig, dates, metrics) {
  const accountStart = new Date();
  utils.log(`\n── Processing: ${clientConfig.name} (${clientConfig.accountId}) ──`, utils.LOG_LEVELS.INFO);

  try {
    // Select this child account so AdsApp queries run against it
    AdsManagerApp.select(account);

    // ── a. Collect + parse campaign data ──────────────────────────────────
    // campaignParser.parseCampaignNames() is called inside collectCampaignData,
    // so each campaign arrives with .location, .campaignType, .identifierValue.
    const campaigns = dataCollection.collectCampaignData(clientConfig, dates);

    if (campaigns.length === 0) {
      utils.log(`No campaigns found for ${clientConfig.name} — skipping`, utils.LOG_LEVELS.WARNING);
      metrics.skippedAccounts++;
      return;
    }

    utils.log(`Collected ${campaigns.length} campaigns`, utils.LOG_LEVELS.INFO);

    if (TEST_MODE) {
      _logCampaignSample(campaigns);
    }

    // ── b. Calculate recommended budgets ──────────────────────────────────
    const recommendedBudgets = budget.calculateRecommendedBudgets(clientConfig, dates);
    utils.log(
      `Recommended budgets calculated for ${Object.keys(recommendedBudgets).length} rows`,
      utils.LOG_LEVELS.INFO
    );

    if (TEST_MODE) {
      _logRecommendedBudgets(recommendedBudgets);
    }

    // ── c. Validate pacing alignment ──────────────────────────────────────
    // Reads Approved Budget column from Budget Input sheet directly.
    const alignment = budget.validateBudgetAlignment(clientConfig, campaigns, dates);

    utils.log(
      `Pacing summary: ok=${alignment.summary.ok} warning=${alignment.summary.warning} ` +
      `critical=${alignment.summary.critical} skipped=${alignment.summary.skipped}`,
      utils.LOG_LEVELS.INFO
    );

    if (TEST_MODE) {
      _logPacingSample(alignment.results);
    }

    // ── d. Write to Campaigns tab ─────────────────────────────────────────
    if (!TEST_MODE) {
      spreadsheetUpdater.updateCampaignsTab(clientConfig, alignment.results, dates);
    } else {
      utils.log('TEST MODE: skipping sheet write', utils.LOG_LEVELS.INFO);
    }

    // ── e. Send alert email ───────────────────────────────────────────────
    if (!TEST_MODE) {
      if (alignment.hasWarning || alignment.hasCritical) {
        const alertSummary = alerter.buildAlertSummary(alignment.results);
        alerter.sendAlertEmail(clientConfig, alertSummary);
      }
    } else {
      utils.log(
        `TEST MODE: skipping email — would flag ${alignment.summary.warning} warning, ${alignment.summary.critical} critical`,
        utils.LOG_LEVELS.INFO
      );
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

// ---------------------------------------------------------------------------
// Test mode logging helpers
// ---------------------------------------------------------------------------

/**
 * Logs a full summary of what was loaded from the Config Workbook.
 * Run once at startup in test mode — verify clients, split rules, locations.
 */
function _logConfigSummary(systemConfig) {
  utils.log('\n── Config load summary ──', utils.LOG_LEVELS.INFO);
  utils.log(`Clients loaded: ${Object.keys(systemConfig.clients).length}`, utils.LOG_LEVELS.INFO);

  Object.values(systemConfig.clients).forEach(c => {
    utils.log(
      `  ${c.name} | ${c.accountId} | budgetInputSheet: "${c.budgetInputSheet}" | ` +
      `splitRules: ${Object.keys(c.splitRules).length} | locations: ${Object.keys(c.locationLookup).length}`,
      utils.LOG_LEVELS.INFO
    );

    Object.entries(c.splitRules).forEach(([type, rule]) => {
      utils.log(
        `    SplitRule: ${type} | pattern: ${rule.authPattern} | ` +
        `splitPct: ${rule.splitPercentage || 'n/a'} | fixedDefault: ${rule.fixedDefault || 'n/a'}`,
        utils.LOG_LEVELS.INFO
      );
    });

    const locEntries = Object.values(c.locationLookup);
    locEntries.slice(0, 3).forEach(loc => {
      utils.log(
        `    Location: "${loc.fullLocation}" | ${loc.identifierLabel}: ${loc.identifierValue}`,
        utils.LOG_LEVELS.INFO
      );
    });
    if (locEntries.length > 3) {
      utils.log(`    ...and ${locEntries.length - 3} more locations`, utils.LOG_LEVELS.INFO);
    }
  });
}

/**
 * Logs the first TEST_LOG_CAMPAIGNS campaigns with their parse results.
 * Verify: location, campaignType, identifierValue, parseWarnings.
 */
function _logCampaignSample(campaigns) {
  utils.log(
    `\n── Campaign parse sample (first ${Math.min(TEST_LOG_CAMPAIGNS, campaigns.length)} of ${campaigns.length}) ──`,
    utils.LOG_LEVELS.INFO
  );

  campaigns.slice(0, TEST_LOG_CAMPAIGNS).forEach((c, i) => {
    utils.log(
      `  [${i + 1}] "${c.name}"\n` +
      `       status=${c.status} | daily=$${c.currentDailyBudget.toFixed(2)} | spendMTD=$${c.spendMTD.toFixed(2)} | daysActive=${c.daysActive}\n` +
      `       location="${c.location}" | type="${c.campaignType}" | siteCode="${c.identifierValue}"\n` +
      `       warnings: ${c.parsedName && c.parsedName.parseWarnings.length ? c.parsedName.parseWarnings.join('; ') : 'none'}`,
      utils.LOG_LEVELS.INFO
    );
  });

  const withWarnings = campaigns.filter(c => c.parsedName && c.parsedName.parseWarnings.length > 0);
  if (withWarnings.length > 0) {
    utils.log(`\n── Parse warnings (${withWarnings.length} campaigns) ──`, utils.LOG_LEVELS.INFO);
    withWarnings.forEach(c => {
      utils.log(`  "${c.name}": ${c.parsedName.parseWarnings.join(' | ')}`, utils.LOG_LEVELS.WARNING);
    });
  } else {
    utils.log('  All campaigns parsed without warnings.', utils.LOG_LEVELS.INFO);
  }
}

/**
 * Logs every recommended budget row.
 * Verify: amounts and auth patterns match expectations.
 */
function _logRecommendedBudgets(recommendedBudgets) {
  utils.log(`\n── Recommended budgets (${Object.keys(recommendedBudgets).length} rows) ──`, utils.LOG_LEVELS.INFO);
  Object.entries(recommendedBudgets).forEach(([key, r]) => {
    utils.log(
      `  ${key} | pattern=${r.authPattern} | recommended=$${r.recommendedBudget.toFixed(2)}`,
      utils.LOG_LEVELS.INFO
    );
  });
}

/**
 * Logs pacing results for the first TEST_LOG_CAMPAIGNS campaigns.
 * Verify: targetDaily, variance, alertLevel look correct.
 */
function _logPacingSample(results) {
  utils.log(
    `\n── Pacing sample (first ${Math.min(TEST_LOG_CAMPAIGNS, results.length)} of ${results.length}) ──`,
    utils.LOG_LEVELS.INFO
  );

  results.slice(0, TEST_LOG_CAMPAIGNS).forEach((r, i) => {
    const p = r.pacing;
    if (p.approvedMonthly === null) {
      utils.log(
        `  [${i + 1}] "${r.campaign.name}" — no approved budget (skipped)`,
        utils.LOG_LEVELS.INFO
      );
      return;
    }
    utils.log(
      `  [${i + 1}] "${r.campaign.name}"\n` +
      `       approved=$${p.approvedMonthly.toFixed(2)} | spendMTD=$${p.spendMTD.toFixed(2)} | remaining=$${p.remainingBudget.toFixed(2)}\n` +
      `       currentDaily=$${p.currentDaily.toFixed(2)} | targetDaily=$${p.targetDaily.toFixed(2)} | impliedMonthly=$${p.impliedMonthly.toFixed(2)}\n` +
      `       variance=${(p.variance * 100).toFixed(1)}% | stage=${p.budgetStage} (±${(p.stageTolerance * 100).toFixed(0)}%) | alert=${p.alertLevel}`,
      utils.LOG_LEVELS.INFO
    );
  });
}
