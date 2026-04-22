/**
 * alerter.gs
 * GLI Budget Pacing System
 *
 * Runs in: MCC Ads Script project only
 *
 * Two responsibilities:
 *   1. flagCampaignCells()  — colors the Alert Level cell in the Campaigns tab
 *   2. sendAlertEmail()     — emails the account manager if any campaigns are
 *                             at warning or critical pacing
 *
 * Dependencies (shared global scope in MCC project):
 *   - utils  (utils.gs)
 *   - MailApp (Google global — available in both Sheets and Ads Scripts)
 */

// ---------------------------------------------------------------------------
// flagCampaignCells
// ---------------------------------------------------------------------------

/**
 * Colors the Alert Level cell for a campaign row in the Campaigns tab.
 * Called by spreadsheetUpdater._applyRowFormatting() for every row written.
 *
 * @param {Sheet}  sheet      The Campaigns tab sheet object
 * @param {number} rowIndex   1-based row index
 * @param {string} alertLevel 'ok' | 'warning' | 'critical' | 'unknown'
 */
function flagCampaignCells(sheet, rowIndex, alertLevel) {
  // Import color map from spreadsheetUpdater (same global scope)
  const colors = {
    ok:       '#e6f4ea', // green
    warning:  '#fef9c3', // yellow
    critical: '#fce8e6', // red
    unknown:  '#f1f3f4', // grey
  };

  const color     = colors[alertLevel] || colors.unknown;
  const colIndex  = spreadsheetUpdater.CAMPAIGNS_COLUMNS.alertLevel.index + 1; // 1-based

  sheet.getRange(rowIndex, colIndex).setBackground(color);
}

// ---------------------------------------------------------------------------
// sendAlertEmail
// ---------------------------------------------------------------------------

/**
 * Sends a plain-text digest email to the account manager listing all
 * campaigns at warning or critical pacing. Skips sending if the summary
 * contains no actionable alerts.
 *
 * @param {Object}   clientConfig   Full client config (needs .name, .accountManagerEmail)
 * @param {Object[]} alertSummary   Array of alert items:
 *                                  { campaignName, location, campaignType, variance, alertLevel }
 */
function sendAlertEmail(clientConfig, alertSummary) {
  const actionable = alertSummary.filter(
    a => a.alertLevel === 'warning' || a.alertLevel === 'critical'
  );

  if (actionable.length === 0) {
    utils.log(
      `sendAlertEmail [${clientConfig.name}]: no actionable alerts — email skipped`,
      utils.LOG_LEVELS.INFO
    );
    return;
  }

  const recipient = clientConfig.accountManagerEmail;
  if (!recipient) {
    utils.log(
      `sendAlertEmail [${clientConfig.name}]: no accountManagerEmail configured — email skipped`,
      utils.LOG_LEVELS.WARNING
    );
    return;
  }

  const dateStr  = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMMM d, yyyy');
  const subject  = `[GLI Alert] Budget Pacing Issues — ${clientConfig.name} — ${dateStr}`;
  const body     = _buildEmailBody(clientConfig, actionable, dateStr);

  try {
    MailApp.sendEmail({ to: recipient, subject, body });
    utils.log(
      `sendAlertEmail [${clientConfig.name}]: sent to ${recipient} — ${actionable.length} alerts`,
      utils.LOG_LEVELS.INFO
    );
  } catch (error) {
    utils.logError(`sendAlertEmail failed for ${clientConfig.name}`, error);
  }
}

// ---------------------------------------------------------------------------
// buildAlertSummary
// ---------------------------------------------------------------------------

/**
 * Converts budget.validateBudgetAlignment() results into the flat array
 * format expected by sendAlertEmail(). Called from main().
 *
 * Filters to warning + critical only so sendAlertEmail() receives a
 * pre-screened list (it also filters internally, but this makes the
 * main() call site cleaner).
 *
 * @param {Object[]} alignmentResults  Output of budget.validateBudgetAlignment().results
 * @returns {Object[]}  Array of { campaignName, location, campaignType, variance, alertLevel }
 */
function buildAlertSummary(alignmentResults) {
  return alignmentResults
    .filter(r => r.pacing.alertLevel === 'warning' || r.pacing.alertLevel === 'critical')
    .map(r => ({
      campaignName: r.campaign.name,
      location:     r.campaign.location     || '',
      campaignType: r.campaign.campaignType || '',
      variance:     r.pacing.variance,
      alertLevel:   r.pacing.alertLevel,
    }));
}

// ---------------------------------------------------------------------------
// Private
// ---------------------------------------------------------------------------

/**
 * Builds the plain-text email body.
 *
 * @param {Object}   clientConfig
 * @param {Object[]} actionable   Pre-filtered warning + critical items
 * @param {string}   dateStr
 * @returns {string}
 */
function _buildEmailBody(clientConfig, actionable, dateStr) {
  const criticalItems = actionable.filter(a => a.alertLevel === 'critical');
  const warningItems  = actionable.filter(a => a.alertLevel === 'warning');

  const lines = [
    `GLI Budget Pacing Alert`,
    `Client: ${clientConfig.name}`,
    `Date:   ${dateStr}`,
    ``,
    `${actionable.length} campaign(s) require attention.`,
    ``,
  ];

  if (criticalItems.length > 0) {
    lines.push(`── CRITICAL (${criticalItems.length}) ──────────────────────────`);
    criticalItems.forEach(a => lines.push(_formatAlertLine(a)));
    lines.push('');
  }

  if (warningItems.length > 0) {
    lines.push(`── WARNING (${warningItems.length}) ───────────────────────────`);
    warningItems.forEach(a => lines.push(_formatAlertLine(a)));
    lines.push('');
  }

  lines.push(
    `────────────────────────────────────────────`,
    `Variance = (Implied Monthly − Approved Monthly) / Approved Monthly`,
    `Positive variance: pacing over budget.`,
    `Negative variance: pacing under budget.`,
    ``,
    `This is an automated message from the GLI Budget Pacing System.`,
    `Log in to the Budget Workbook to review and adjust.`
  );

  return lines.join('\n');
}

/**
 * Formats a single alert line for the email body.
 *
 * @param {Object} alert  { campaignName, location, campaignType, variance, alertLevel }
 * @returns {string}
 */
function _formatAlertLine(alert) {
  const variancePct = alert.variance !== null
    ? `${alert.variance >= 0 ? '+' : ''}${(alert.variance * 100).toFixed(1)}%`
    : 'N/A';

  return `  ${alert.location} — ${alert.campaignType}  |  Variance: ${variancePct}  |  ${alert.campaignName}`;
}

// ---------------------------------------------------------------------------
// Module export
// ---------------------------------------------------------------------------

const alerter = {
  flagCampaignCells,
  sendAlertEmail,
  buildAlertSummary,
};
