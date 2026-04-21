function debugWorkbooks() {
  const config = configManager.loadConfiguration();
  const client = Object.values(config.clients)[0];
  Logger.log('Client: ' + client.name);
  Logger.log('Config URL set: ' + (configManager.AGENCY_CONFIG_URL !== 'YOUR_CONFIG_WORKBOOK_URL_HERE'));
  Logger.log('Budget URL set: ' + (configManager.AGENCY_BUDGET_URL !== 'YOUR_BUDGET_WORKBOOK_URL_HERE'));

  const budgetSs = SpreadsheetApp.openByUrl(configManager.AGENCY_BUDGET_URL);
  const sheet    = budgetSs.getSheetByName(client.budgetInputSheet);
  Logger.log('Budget input sheet found: ' + (sheet !== null));
  Logger.log('Rows: ' + (sheet ? sheet.getLastRow() : 'N/A'));
}

function debugApprovals() {
  const config = configManager.loadConfiguration();
  const client = Object.values(config.clients)[0];
  const approvals = budgetInput.readClientApprovals(client);
  Logger.log(JSON.stringify(approvals, null, 2));
}

/**
 * GLI Budget Pacing System - Budget Input & Approval Module
 * Version: 2.0.0
 *
 * Manages the Budget Input tab structure:
 *   - One row per Location × Campaign Type
 *   - Three authorization patterns (A, B, C)
 *   - Monthly approval checkbox with auto-timestamp
 *   - LASTMONTHBUDGET updated for new row structure
 *   - "Prepare Next Month" manual trigger
 *   - "Send to Client" push to client workbook
 */

// ─── Budget Input Tab Column Schema ──────────────────────────────────────────
//
// Column layout for "[ClientName] - Budget Input" sheets:
//
// A  Location                   — e.g. "Riverside"
// B  Campaign Type              — e.g. "Brand"
// C  Auth Pattern               — percentage | fixed_memory | annual_override
// D  Location Monthly Budget    — entered by account manager
// E  Split %                    — for Pattern A (e.g. 0.30)
// F  Recommended Budget         — calculated: D×E (Pattern A) or fixed (B/C)
// G  Pre-Approved Budget        — optional client pre-approval override
// H  Approved Budget            — final approved amount (client fills in client WB, synced here)
// I  Recommended Budget Approved — checkbox (client)
// J  No Ads This Month          — checkbox (client)
// K  Approval Timestamp         — auto-set when I checked
// L  Disapproval Timestamp      — auto-set when J checked
// M  Pre-Approval Timestamp     — auto-set when G edited
// N  Budget Total Timestamp     — auto-set when H edited
// O  Last Month Approved        — LASTMONTHBUDGET result (read-only, formula)
// P  Notes                      — account manager notes
//
// ─────────────────────────────────────────────────────────────────────────────

const BUDGET_INPUT_COLUMNS = {
  location:           { index: 0,  header: 'Location',                    col: 'A' },
  campaignType:       { index: 1,  header: 'Campaign Type',               col: 'B' },
  authPattern:        { index: 2,  header: 'Auth Pattern',                col: 'C' },
  locationBudget:     { index: 3,  header: 'Location Monthly Budget',     col: 'D' },
  splitPct:           { index: 4,  header: 'Split %',                     col: 'E' },
  recommendedBudget:  { index: 5,  header: 'Recommended Budget',          col: 'F' },
  preApprovedBudget:  { index: 6,  header: 'Pre-Approved Budget',         col: 'G' },
  approvedBudget:     { index: 7,  header: 'Approved Budget',             col: 'H' },
  approvedCheckbox:   { index: 8,  header: 'Recommended Budget Approved', col: 'I' },
  noAdsCheckbox:      { index: 9,  header: 'No Ads This Month',           col: 'J' },
  approvalTimestamp:  { index: 10, header: 'Approval Timestamp',          col: 'K' },
  disapprovalTs:      { index: 11, header: 'Disapproval Timestamp',       col: 'L' },
  preApprovalTs:      { index: 12, header: 'Pre-Approval Timestamp',      col: 'M' },
  budgetTotalTs:      { index: 13, header: 'Budget Total Timestamp',      col: 'N' },
  lastMonthApproved:  { index: 14, header: 'Last Month Approved',         col: 'O' },
  notes:              { index: 15, header: 'Notes',                       col: 'P' }
};

const BUDGET_INPUT_HEADER_ROW = Object.values(BUDGET_INPUT_COLUMNS).map(c => c.header);
const BUDGET_INPUT_NUM_COLS   = BUDGET_INPUT_HEADER_ROW.length;

// ─── Sheet Setup ──────────────────────────────────────────────────────────────

/**
 * Create or reset a Budget Input tab for a client.
 * Safe to call on existing sheets — only adds header if missing.
 * @param {Spreadsheet} ss
 * @param {string}      sheetName  — e.g. "Trojan Storage - Budget Input"
 * @param {string}      monthLabel — e.g. "April 2026"
 * @returns {Sheet}
 */
function setupBudgetInputSheet(ss, sheetName, monthLabel) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  }

  // Only write headers if sheet is empty
  if (sheet.getLastRow() === 0) {
    const headerRange = sheet.getRange(1, 1, 1, BUDGET_INPUT_NUM_COLS);
    headerRange.setValues([BUDGET_INPUT_HEADER_ROW]);
    headerRange.setFontWeight('bold').setBackground('#e8eaf6');
    sheet.setFrozenRows(1);

    // Set column widths
    sheet.setColumnWidth(colLetter2Index('A'), 160); // Location
    sheet.setColumnWidth(colLetter2Index('B'), 120); // Campaign Type
    sheet.setColumnWidth(colLetter2Index('C'), 140); // Auth Pattern
    sheet.setColumnWidth(colLetter2Index('D'), 160); // Location Monthly Budget
    sheet.setColumnWidth(colLetter2Index('E'), 80);  // Split %
    sheet.setColumnWidth(colLetter2Index('F'), 160); // Recommended Budget
    sheet.setColumnWidth(colLetter2Index('G'), 160); // Pre-Approved Budget
    sheet.setColumnWidth(colLetter2Index('H'), 160); // Approved Budget
    sheet.setColumnWidth(colLetter2Index('I'), 180); // Approved checkbox
    sheet.setColumnWidth(colLetter2Index('J'), 160); // No Ads checkbox

    // Currency format for budget columns
    const budgetCols = ['D', 'F', 'G', 'H', 'O'];
    budgetCols.forEach(col => {
      sheet.getRange(`${col}2:${col}1000`).setNumberFormat('$#,##0.00');
    });

    // Percentage format for Split %
    sheet.getRange('E2:E1000').setNumberFormat('0%');

    utils.log(`Created Budget Input sheet: ${sheetName}`, utils.LOG_LEVELS.INFO);
  }

  return sheet;
}

// ─── Prepare Next Month ───────────────────────────────────────────────────────

/**
 * Menu trigger: Prepare Next Month's Budget Input tab.
 * - Creates the tab if it doesn't exist
 * - Pre-populates from this month's approved amounts (LASTMONTHBUDGET logic)
 * - Auto-checks Pattern C rows if amount unchanged
 * - Clears approval checkboxes and timestamps for fresh approval cycle
 *
 * @param {Object} clientConfig
 */
function prepareNextMonthBudgetInput(clientConfig) {
  try {
    const ss       = SpreadsheetApp.openByUrl(clientConfig.clientWorkbookUrl);
    // Agency side for reading current approved amounts
    const agencySs = SpreadsheetApp.openByUrl(configManager.AGENCY_BUDGET_URL);

    const today        = new Date();
    const nextMonth    = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const nextLabel    = Utilities.formatDate(nextMonth, Session.getScriptTimeZone(), 'MMMM yyyy');
    const currentLabel = Utilities.formatDate(today,    Session.getScriptTimeZone(), 'MMMM yyyy');

    const currentSheetName = `${clientConfig.name} - ${currentLabel} Budget Input`;
    const nextSheetName    = `${clientConfig.name} - ${nextLabel} Budget Input`;

    // Get current month's data
    const currentSheet = agencySs.getSheetByName(currentSheetName)
                      || agencySs.getSheetByName(clientConfig.budgetInputSheet);

    if (!currentSheet) {
      SpreadsheetApp.getActive().toast(
        `Could not find current budget sheet: ${currentSheetName}`,
        'Prepare Next Month', 5
      );
      return;
    }

    // Set up next month's sheet
    const nextSheet = setupBudgetInputSheet(agencySs, nextSheetName, nextLabel);

    // Copy rows from current month, resetting approval state
    const currentData    = currentSheet.getDataRange().getValues();
    if (currentData.length <= 1) {
      SpreadsheetApp.getActive().toast('Current budget sheet has no data rows.', 'Prepare Next Month', 5);
      return;
    }

    const newRows = [];
    for (let i = 1; i < currentData.length; i++) {
      const row = currentData[i];

      const location     = row[BUDGET_INPUT_COLUMNS.location.index];
      const campaignType = row[BUDGET_INPUT_COLUMNS.campaignType.index];
      const authPattern  = row[BUDGET_INPUT_COLUMNS.authPattern.index];
      const approvedAmt  = row[BUDGET_INPUT_COLUMNS.approvedBudget.index] || 0;
      const splitPct     = row[BUDGET_INPUT_COLUMNS.splitPct.index];
      const notes        = row[BUDGET_INPUT_COLUMNS.notes.index];

      if (!location && !campaignType) continue; // skip blank rows

      const newRow                                         = new Array(BUDGET_INPUT_NUM_COLS).fill('');
      newRow[BUDGET_INPUT_COLUMNS.location.index]          = location;
      newRow[BUDGET_INPUT_COLUMNS.campaignType.index]      = campaignType;
      newRow[BUDGET_INPUT_COLUMNS.authPattern.index]       = authPattern;
      newRow[BUDGET_INPUT_COLUMNS.splitPct.index]          = splitPct;
      newRow[BUDGET_INPUT_COLUMNS.notes.index]             = notes;

      // Pre-populate budget amounts from last month
      newRow[BUDGET_INPUT_COLUMNS.locationBudget.index]    = row[BUDGET_INPUT_COLUMNS.locationBudget.index];
      newRow[BUDGET_INPUT_COLUMNS.lastMonthApproved.index] = approvedAmt;

      // Pattern C: auto-check approval if amount matches last month
      const isPatternC = authPattern === configManager.AUTHORIZATION_PATTERNS.ANNUAL_OVERRIDE;
      if (isPatternC && approvedAmt > 0) {
        newRow[BUDGET_INPUT_COLUMNS.recommendedBudget.index] = approvedAmt;
        newRow[BUDGET_INPUT_COLUMNS.approvedCheckbox.index]  = true; // auto-approve
        newRow[BUDGET_INPUT_COLUMNS.approvalTimestamp.index] = new Date();
      }

      // All other patterns: clear approval, pre-populate recommended from last
      if (!isPatternC) {
        newRow[BUDGET_INPUT_COLUMNS.recommendedBudget.index] = approvedAmt; // default to last
        newRow[BUDGET_INPUT_COLUMNS.approvedCheckbox.index]  = false;
      }

      newRows.push(newRow);
    }

    if (newRows.length > 0) {
      nextSheet.getRange(2, 1, newRows.length, BUDGET_INPUT_NUM_COLS).setValues(newRows);
      applyBudgetInputFormatting(nextSheet, newRows.length);
    }

    SpreadsheetApp.getActive().toast(
      `Next month tab "${nextSheetName}" prepared with ${newRows.length} rows.`,
      'Prepare Next Month', 5
    );

    utils.log(`Prepared next month budget input: ${nextSheetName}`, utils.LOG_LEVELS.INFO);
  } catch (error) {
    utils.logError('Error preparing next month budget input', error);
    SpreadsheetApp.getActive().toast('Error: ' + error.message, 'Prepare Next Month', 10);
  }
}

// ─── Send to Client ───────────────────────────────────────────────────────────

/**
 * Menu trigger: Push recommended budgets from agency sheet to client workbook.
 * Client workbook gets: Location, Campaign Type, Recommended Budget, approval checkbox.
 * @param {Object} clientConfig
 */
function sendRecommendedBudgetsToClient(clientConfig) {
  try {
    const agencySs     = SpreadsheetApp.openByUrl(configManager.AGENCY_BUDGET_URL);
    const agencySheet  = agencySs.getSheetByName(clientConfig.budgetInputSheet);

    if (!agencySheet) {
      throw new Error(`Agency budget input sheet not found: ${clientConfig.budgetInputSheet}`);
    }

    const clientSs    = SpreadsheetApp.openByUrl(clientConfig.clientWorkbookUrl);
    const clientSheet = getOrCreateClientApprovalSheet(clientSs, clientConfig.name);

    const agencyData = agencySheet.getDataRange().getValues();
    if (agencyData.length <= 1) {
      SpreadsheetApp.getActive().toast('No budget rows to send.', 'Send to Client', 5);
      return;
    }

    // Build client-facing rows
    // Client sees: Location | Campaign Type | Recommended Budget | Approve? | No Ads?
    const CLIENT_HEADERS = [
      'Location', 'Campaign Type', 'Recommended Budget',
      'Recommended Budget Approved', 'No Ads This Month',
      'Approval Timestamp', 'Disapproval Timestamp', 'Notes'
    ];

    // Ensure headers exist
    if (clientSheet.getLastRow() === 0 ||
        clientSheet.getRange(1, 1).getValue() !== CLIENT_HEADERS[0]) {
      clientSheet.getRange(1, 1, 1, CLIENT_HEADERS.length).setValues([CLIENT_HEADERS]);
      clientSheet.getRange(1, 1, 1, CLIENT_HEADERS.length)
        .setFontWeight('bold').setBackground('#e8eaf6');
      clientSheet.setFrozenRows(1);
    }

    // Clear existing data rows (keep header)
    if (clientSheet.getLastRow() > 1) {
      clientSheet.getRange(2, 1, clientSheet.getLastRow() - 1, CLIENT_HEADERS.length).clearContent();
    }

    const clientRows = [];
    for (let i = 1; i < agencyData.length; i++) {
      const row = agencyData[i];
      const location    = row[BUDGET_INPUT_COLUMNS.location.index];
      const type        = row[BUDGET_INPUT_COLUMNS.campaignType.index];
      const recommended = row[BUDGET_INPUT_COLUMNS.recommendedBudget.index];
      const noAds       = row[BUDGET_INPUT_COLUMNS.noAdsCheckbox.index];

      if (!location && !type) continue;

      // Preserve existing approval state if row already exists in client sheet
      // (don't overwrite a client's checkbox they already checked)
      clientRows.push([location, type, recommended, false, noAds || false, '', '', '']);
    }

    if (clientRows.length > 0) {
      clientSheet.getRange(2, 1, clientRows.length, CLIENT_HEADERS.length).setValues(clientRows);
      // Format budget column
      clientSheet.getRange(2, 3, clientRows.length, 1).setNumberFormat('$#,##0.00');
    }

    SpreadsheetApp.getActive().toast(
      `Sent ${clientRows.length} budget rows to client workbook.`,
      'Send to Client', 5
    );

    utils.log(`Sent budgets to client: ${clientConfig.name}`, utils.LOG_LEVELS.INFO);
  } catch (error) {
    utils.logError('Error sending budgets to client', error);
    SpreadsheetApp.getActive().toast('Error: ' + error.message, 'Send to Client', 10);
  }
}

// ─── Read Client Approvals ────────────────────────────────────────────────────

function readClientApprovals(clientConfig) {
  try {
    const clientSs    = SpreadsheetApp.openByUrl(clientConfig.clientWorkbookUrl);
    const clientSheet = clientSs.getSheetByName(`${clientConfig.name} - Budget Approval`);

    if (!clientSheet) {
      utils.log(`Client approval sheet not found for ${clientConfig.name}`, utils.LOG_LEVELS.WARNING);
      return {};
    }

    const data    = clientSheet.getDataRange().getValues();
    const headers = data[0];
    const approvals = {};

    const ci = {
      location:          headers.indexOf('Location'),
      campaignType:      headers.indexOf('Campaign Type'),
      recommendedBudget: headers.indexOf('Recommended Budget'),
      approved:          headers.indexOf('Recommended Budget Approved'),
      noAds:             headers.indexOf('No Ads This Month')
    };

    for (let i = 1; i < data.length; i++) {
      const row      = data[i];
      const location = row[ci.location];
      const type     = row[ci.campaignType];
      if (!location && !type) continue;

      const key = campaignParser.buildLocationTypeKey(location, type);
      approvals[key] = {
        approved:          row[ci.approved]          === true,
        noAds:             row[ci.noAds]             === true,
        recommendedBudget: row[ci.recommendedBudget] || 0
      };
    }

    utils.log(`Read ${Object.keys(approvals).length} approval rows for ${clientConfig.name}`, utils.LOG_LEVELS.INFO);
    return approvals;
  } catch (error) {
    utils.logError(`Error reading client approvals for ${clientConfig.name}`, error);
    return {};
  }
}

// ─── Sync Approvals to Budget Workbook ───────────────────────────────────────

/**
 * Read approvals from client workbook and write them back into the
 * agency Budget Input sheet (columns H, I, J, K, L).
 * @param {Object} clientConfig
 * @returns {number} count of rows updated
 */
function syncApprovalsToAgencySheet(clientConfig) {
  try {
    const approvals = readClientApprovals(clientConfig);
    if (Object.keys(approvals).length === 0) {
      utils.log('No approvals to sync', utils.LOG_LEVELS.WARNING);
      return 0;
    }

    const budgetSs    = SpreadsheetApp.openByUrl(configManager.AGENCY_BUDGET_URL);
    const budgetSheet = budgetSs.getSheetByName(clientConfig.budgetInputSheet);

    if (!budgetSheet) {
      throw new Error(`Budget input sheet not found: ${clientConfig.budgetInputSheet}`);
    }

    const data = budgetSheet.getDataRange().getValues();
    let updatedCount = 0;

    for (let i = 1; i < data.length; i++) {
      const row      = data[i];
      const location = row[BUDGET_INPUT_COLUMNS.location.index];
      const type     = row[BUDGET_INPUT_COLUMNS.campaignType.index];
      if (!location && !type) continue;

      const key      = campaignParser.buildLocationTypeKey(location, type);
      const approval = approvals[key];
      if (!approval) continue;

      const sheetRow = i + 1; // 1-based

      // Write approved budget amount into col H
      if (approval.approved && approval.recommendedBudget > 0) {
        budgetSheet.getRange(sheetRow, BUDGET_INPUT_COLUMNS.approvedBudget.index + 1)
          .setValue(approval.recommendedBudget)
          .setNumberFormat('$#,##0.00');
      }

      // Write approval checkbox col I
      budgetSheet.getRange(sheetRow, BUDGET_INPUT_COLUMNS.approvedCheckbox.index + 1)
        .setValue(approval.approved);

      // Write no-ads checkbox col J
      budgetSheet.getRange(sheetRow, BUDGET_INPUT_COLUMNS.noAdsCheckbox.index + 1)
        .setValue(approval.noAds);

      // Write approval timestamp col K if approved
      if (approval.approved) {
        const tsCell = budgetSheet.getRange(sheetRow, BUDGET_INPUT_COLUMNS.approvalTimestamp.index + 1);
        if (!tsCell.getValue()) { // don't overwrite existing timestamp
          tsCell.setValue(new Date())
            .setNumberFormat('dddd m/d/yy "at" hh:mm A/P".M."');
        }
      }

      updatedCount++;
    }

    utils.log(`Synced ${updatedCount} approval rows to agency sheet`, utils.LOG_LEVELS.INFO);
    SpreadsheetApp.getActive().toast(
      `Synced ${updatedCount} approvals from client workbook.`,
      'Approval Sync', 4
    );
    return updatedCount;

  } catch (error) {
    utils.logError('Error syncing approvals to agency sheet', error);
    SpreadsheetApp.getActive().toast('Error: ' + error.message, 'Approval Sync', 10);
    return 0;
  }
}

// ─── LASTMONTHBUDGET (Updated) ────────────────────────────────────────────────

/**
 * Custom sheet function: look up last month's approved budget for a
 * location × campaign type combination.
 *
 * Usage in sheet: =LASTMONTHBUDGET("Riverside", "Brand")
 * Or omit args when called from a named range context.
 *
 * Logic (in order):
 *   1. No Ads This Month checked → return 0
 *   2. Approved Budget (H) set   → return that amount
 *   3. Pre-Approved Budget (G)   → return that
 *   4. Last Month Approved (O)   → return that
 *   5. Else → return "#N/A"
 *
 * @param {string} location      — location name to match (col A)
 * @param {string} campaignType  — campaign type to match (col B)
 * @param {string} [sheetName]   — override sheet name (defaults to previous month)
 * @returns {number|string}
 */
function LASTMONTHBUDGET(location, campaignType, sheetName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Determine which sheet to look in
  let targetSheetName = sheetName;
  if (!targetSheetName) {
    const today    = new Date();
    const prevDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    // Sheet naming convention: "[ClientName] - [Month YYYY] Budget Input"
    // We search for any sheet matching "Budget Input" for last month
    const prevLabel = Utilities.formatDate(prevDate, Session.getScriptTimeZone(), 'MMMM yyyy');
    const allSheets = ss.getSheets().map(s => s.getName());
    targetSheetName = allSheets.find(n => n.includes(prevLabel) && n.includes('Budget Input'));
  }

  if (!targetSheetName) return '#N/A';

  const prevSheet = ss.getSheetByName(targetSheetName);
  if (!prevSheet) return '#N/A';

  const data = prevSheet.getDataRange().getValues();

  // Find matching row (skip header row 0)
  for (let i = 1; i < data.length; i++) {
    const rowLocation = (data[i][BUDGET_INPUT_COLUMNS.location.index]     || '').toString().trim();
    const rowType     = (data[i][BUDGET_INPUT_COLUMNS.campaignType.index] || '').toString().trim();

    const locationMatch    = rowLocation.toLowerCase()    === location.toString().trim().toLowerCase();
    const campaignTypeMatch = rowType.toLowerCase()       === campaignType.toString().trim().toLowerCase();

    if (!locationMatch || !campaignTypeMatch) continue;

    const noAds       = data[i][BUDGET_INPUT_COLUMNS.noAdsCheckbox.index];
    const approved    = data[i][BUDGET_INPUT_COLUMNS.approvedBudget.index];
    const preApproved = data[i][BUDGET_INPUT_COLUMNS.preApprovedBudget.index];
    const lastMonth   = data[i][BUDGET_INPUT_COLUMNS.lastMonthApproved.index];

    if (noAds === true)                               return 0;
    if (typeof approved    === 'number' && approved    > 0) return Math.round(approved);
    if (typeof preApproved === 'number' && preApproved > 0) return Math.round(preApproved);
    if (typeof lastMonth   === 'number' && lastMonth   > 0) return Math.round(lastMonth);

    return '#N/A';
  }

  return '#N/A'; // row not found
}

// ─── onEdit Handler (Budget Input) ───────────────────────────────────────────

/**
 * onEdit handler for Budget Input sheets.
 * Called from main onEdit.gs — handles timestamp logic for approval columns.
 * @param {Object} event
 */
function handleBudgetInputEdit(event) {
  const sheet     = event.range.getSheet();
  const sheetName = sheet.getName();

  if (!sheetName.includes('Budget Input')) return;

  const row        = event.range.getRow();
  const col        = event.range.getColumn();
  const value      = event.range.getValue();

  if (row <= 1) return; // ignore header

  // Column index is 1-based from getColumn(), convert to 0-based for our map
  const colIndex0 = col - 1;

  const stampMap = {
    [BUDGET_INPUT_COLUMNS.approvedCheckbox.index]:  {
      tsCol:   BUDGET_INPUT_COLUMNS.approvalTimestamp.index + 1,
      watchVal: true
    },
    [BUDGET_INPUT_COLUMNS.noAdsCheckbox.index]: {
      tsCol:   BUDGET_INPUT_COLUMNS.disapprovalTs.index + 1,
      watchVal: true
    },
    [BUDGET_INPUT_COLUMNS.preApprovedBudget.index]: {
      tsCol:   BUDGET_INPUT_COLUMNS.preApprovalTs.index + 1,
      watchVal: undefined // any change
    },
    [BUDGET_INPUT_COLUMNS.approvedBudget.index]: {
      tsCol:     BUDGET_INPUT_COLUMNS.budgetTotalTs.index + 1,
      watchVal:  undefined,
      eraseable: true
    }
  };

  const config = stampMap[colIndex0];
  if (!config) return;

  // Only act if watchVal matches (or watchVal is undefined = any change)
  if (config.watchVal !== undefined && value !== config.watchVal) return;

  const tsCell = sheet.getRange(row, config.tsCol);

  if (config.eraseable && (value === '' || value === null || value === 0)) {
    tsCell.setValue(null);
  } else {
    tsCell.setValue(new Date()).setNumberFormat('dddd m/d/yy "at" hh:mm A/P".M."');
  }
}

// ─── Formatting Helpers ───────────────────────────────────────────────────────

/**
 * Apply conditional formatting to a Budget Input sheet.
 * Green = approved, red = no ads, yellow = unapproved with budget set.
 * @param {Sheet}  sheet
 * @param {number} numDataRows
 */
function applyBudgetInputFormatting(sheet, numDataRows) {
  if (numDataRows <= 0) return;
  const dataRange = sheet.getRange(2, 1, numDataRows, BUDGET_INPUT_NUM_COLS);

  // Clear existing rules on these ranges
  let rules = sheet.getConditionalFormatRules().filter(r => {
    return !r.getRanges().some(rng => rng.getRow() >= 2);
  });

  const approvedRange = sheet.getRange(2, BUDGET_INPUT_COLUMNS.approvedCheckbox.index + 1, numDataRows, 1);
  const noAdsRange    = sheet.getRange(2, BUDGET_INPUT_COLUMNS.noAdsCheckbox.index + 1,    numDataRows, 1);
  const rowRange      = sheet.getRange(2, 1, numDataRows, BUDGET_INPUT_NUM_COLS);

  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(`=$I2=TRUE`)
      .setBackground('#e6f4ea')
      .setRanges([rowRange])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(`=$J2=TRUE`)
      .setBackground('#fce8e6')
      .setRanges([rowRange])
      .build()
  );

  sheet.setConditionalFormatRules(rules);
}

/**
 * Get or create the client-facing approval sheet in the client workbook.
 * @param {Spreadsheet} clientSs
 * @param {string}      clientName
 * @returns {Sheet}
 */
function getOrCreateClientApprovalSheet(clientSs, clientName) {
  const name  = `${clientName} - Budget Approval`;
  let sheet   = clientSs.getSheetByName(name);
  if (!sheet) {
    sheet = clientSs.insertSheet(name);
    utils.log(`Created client approval sheet: ${name}`, utils.LOG_LEVELS.INFO);
  }
  return sheet;
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * Convert a column letter to a 1-based column index.
 * @param {string} letter — e.g. 'A' → 1, 'P' → 16
 * @returns {number}
 */
function colLetter2Index(letter) {
  return letter.toUpperCase().charCodeAt(0) - 64;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

const budgetInput = {
  BUDGET_INPUT_COLUMNS,
  BUDGET_INPUT_HEADER_ROW,
  setupBudgetInputSheet,
  prepareNextMonthBudgetInput,
  sendRecommendedBudgetsToClient,
  readClientApprovals,
  handleBudgetInputEdit,
  applyBudgetInputFormatting,
  LASTMONTHBUDGET,
  syncApprovalsToAgencySheet
};
