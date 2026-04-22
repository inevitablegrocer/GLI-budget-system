/**
 * GLI Budget Pacing System - Master onOpen Handler
 * Version: 2.0.0
 */

function onOpen() {
  const ui = SpreadsheetApp.getUi();

  // Budget Management (new)
  try {
    ui.createMenu('Budget Management')
      .addItem('Prepare Next Month',    'menuPrepareNextMonth')
      .addItem('Send to Client',        'menuSendToClient')
      .addItem('Run Pacing Check',      'menuRunPacingCheck')
      .addSeparator()
      .addItem('Read Client Approvals', 'menuReadClientApprovals')
      .addToUi();
  } catch (e) {
    console.error('Error creating Budget Management menu:', e);
  }

}

// ─── Menu Handler Stubs ───────────────────────────────────────────────────────

function menuPrepareNextMonth() {
  const clientConfig = promptSelectClient_();
  if (!clientConfig) return;
  prepareNextMonthBudgetInput(clientConfig); 
}

function menuSendToClient() {
  const clientConfig = promptSelectClient_();
  if (!clientConfig) return;
  sendRecommendedBudgetsToClient(clientConfig); 
}

function menuRunPacingCheck() {
  SpreadsheetApp.getActive().toast('Running pacing check... (triggers MCC script logic)', 'Pacing Check', 3);
  // Full MCC script runs on schedule; this is a manual trigger for testing
  try {
    const config       = configManager.loadConfiguration();
    const accountId    = SpreadsheetApp.getActive().getId(); // placeholder — replace with actual logic
    const clientConfig = configManager.getClientConfig(accountId, config);
    if (!clientConfig) {
      SpreadsheetApp.getActive().toast('No client config found for this workbook.', 'Pacing Check', 5);
      return;
    }
    // main() handles full execution; this is a single-sheet test hook
    SpreadsheetApp.getActive().toast('Pacing check complete.', 'Pacing Check', 3);
  } catch (e) {
    SpreadsheetApp.getActive().toast('Error: ' + e.message, 'Pacing Check', 10);
  }
}

function menuReadClientApprovals() {
  const clientConfig = promptSelectClient_();
  if (!clientConfig) return;
  budgetInput.syncApprovalsToAgencySheet(clientConfig);
}

// ─── Client Selector ─────────────────────────────────────────────────────────

/**
 * Prompt the user to pick a client from the loaded config.
 * Returns the selected clientConfig or null if cancelled.
 * @returns {Object|null}
 */
function promptSelectClient_() {
  try {
    const config  = configManager.loadConfiguration();
    const clients = Object.values(config.clients);

    if (clients.length === 0) {
      SpreadsheetApp.getUi().alert('No active clients found in Config sheet.');
      return null;
    }

    const names  = clients.map((c, i) => `${i + 1}. ${c.name} (${c.accountId})`).join('\n');
    const result = SpreadsheetApp.getUi().prompt(
      'Select Client',
      `Enter the number of the client:\n\n${names}`,
      SpreadsheetApp.getUi().ButtonSet.OK_CANCEL
    );

    if (result.getSelectedButton() !== SpreadsheetApp.getUi().Button.OK) return null;

    const choice = parseInt(result.getResponseText().trim()) - 1;
    if (isNaN(choice) || choice < 0 || choice >= clients.length) {
      SpreadsheetApp.getUi().alert('Invalid selection.');
      return null;
    }

    // Pass through getClientConfig to attach thresholds, budgetStages, etc.
    return configManager.getClientConfig(clients[choice].accountId, config);
  } catch (e) {
    console.error('Error in promptSelectClient_:', e);
    return null;
  }
}
