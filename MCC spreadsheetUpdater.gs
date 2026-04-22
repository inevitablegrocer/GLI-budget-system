/**
 * spreadsheetUpdater.gs
 * GLI Budget Pacing System
 *
 * Runs in: MCC Ads Script project only
 *
 * Writes pacing results from budget.validateBudgetAlignment() to the
 * "[ClientName] - Campaigns" tab in the agency Budget Workbook.
 *
 * Matching strategy:
 *   Each Google Ads campaign is matched to a sheet row by Site Code
 *   (identifierValue) + Campaign Type. If no Site Code is available the
 *   full location string is used as a fallback.
 *
 * Write rules:
 *   - Creates the Campaigns tab and header row if absent
 *   - Upserts rows: matches on Site Code + Campaign Type, appends if new
 *   - NEVER overwrites "Approved Monthly" — that column is owned by the
 *     Budget Input sync workflow (budgetInput.syncApprovalsToAgencySheet)
 *   - Color-codes the Alert Level cell via alerter.flagCampaignCells()
 *
 * Dependencies (shared global scope in MCC project):
 *   - alerter       (alerter.gs)
 *   - campaignParser (campaignParser.gs)
 *   - utils         (utils.gs)
 *   - SpreadsheetApp (Google global)
 */

// ---------------------------------------------------------------------------
// Campaigns tab column schema
// ---------------------------------------------------------------------------

/**
 * Ordered column definitions for the "[ClientName] - Campaigns" tab.
 * index is 0-based; col is the A1 letter (informational only).
 *
 * To add a column: append an entry here. The write logic references columns
 * by key name, not position, so reordering here is safe as long as you also
 * update the header string.
 */
const CAMPAIGNS_COLUMNS = {
  siteCode:         { index: 0,  header: 'Site Code'         },
  location:         { index: 1,  header: 'Location'          },
  campaignType:     { index: 2,  header: 'Campaign Type'     },
  campaignName:     { index: 3,  header: 'Campaign Name'     },
  status:           { index: 4,  header: 'Status'            },
  dailyBudget:      { index: 5,  header: 'Daily Budget'      },
  impliedMonthly:   { index: 6,  header: 'Implied Monthly'   },
  approvedMonthly:  { index: 7,  header: 'Approved Monthly'  },
  variancePct:      { index: 8,  header: 'Variance %'        },
  alertLevel:       { index: 9,  header: 'Alert Level'       },
  spendMTD:         { index: 10, header: 'Spend MTD'         },
  projectedSpend:   { index: 11, header: 'Projected Spend'   },
  pacingPct:        { index: 12, header: 'Pacing %'          },
  impressions:      { index: 13, header: 'Impressions'       },
  clicks:           { index: 14, header: 'Clicks'            },
  ctr:              { index: 15, header: 'CTR'               },
  leads:            { index: 16, header: 'Leads'             },  // Phase 2
  cpl:              { index: 17, header: 'CPL'               },  // Phase 2
  bidStrategy:      { index: 18, header: 'Bid Strategy'      },
  recommendedDaily: { index: 19, header: 'Recommended Daily' },
  lastUpdated:      { index: 20, header: 'Last Updated'      },
};

const CAMPAIGNS_HEADER_ROW = Object.values(CAMPAIGNS_COLUMNS)
  .sort((a, b) => a.index - b.index)
  .map(c => c.header);

const CAMPAIGNS_NUM_COLS = CAMPAIGNS_HEADER_ROW.length;

// Cell background colors for alert levels
const ALERT_COLORS = {
  ok:       '#e6f4ea', // green
  warning:  '#fef9c3', // yellow
  critical: '#fce8e6', // red
  unknown:  '#f1f3f4', // grey — no pacing data
};

// ---------------------------------------------------------------------------
// updateCampaignsTab  (primary entry point)
// ---------------------------------------------------------------------------

/**
 * Writes pacing results for all campaigns to the Campaigns tab.
 * Called once per client from main().
 *
 * @param {Object}   clientConfig   Full client config
 * @param {Object[]} alignmentResults  Output of budget.validateBudgetAlignment().results
 *                                     Each element: { campaign, pacing, key }
 * @param {Object}   dates          From budget.buildDatesObject()
 */
function updateCampaignsTab(clientConfig, alignmentResults, dates) {
  try {
    const ss        = SpreadsheetApp.openByUrl(AGENCY_BUDGET_URL);
    const tabName   = `${clientConfig.agencySheetName} - Campaigns`;
    const sheet     = _getOrCreateCampaignsSheet(ss, tabName);

    // Read existing rows into a lookup map: matchKey → rowIndex (1-based, header = row 1)
    const existingRows = _buildExistingRowMap(sheet);

    const now        = new Date();
    const rowBuffer  = {}; // matchKey → row array, for batch writing

    for (const { campaign, pacing } of alignmentResults) {
      const matchKey = _buildMatchKey(campaign);
      const rowIndex = existingRows[matchKey]; // undefined if new campaign

      const rowData = _buildRowData(campaign, pacing, dates, now, sheet, rowIndex);

      if (rowIndex) {
        rowBuffer[rowIndex] = rowData;
      } else {
        // New campaign — will be appended after processing all existing rows
        rowBuffer[`new_${matchKey}`] = rowData;
      }
    }

    // Write updates to existing rows
    for (const [key, rowData] of Object.entries(rowBuffer)) {
      if (key.startsWith('new_')) continue;
      const rowIndex = Number(key);
      _writeRow(sheet, rowIndex, rowData, alignmentResults, key);
    }

    // Append new rows
    const newRows = Object.entries(rowBuffer)
      .filter(([key]) => key.startsWith('new_'))
      .map(([, rowData]) => rowData.values);

    if (newRows.length > 0) {
      const startRow = sheet.getLastRow() + 1;
      sheet.getRange(startRow, 1, newRows.length, CAMPAIGNS_NUM_COLS).setValues(newRows);

      // Apply formatting and alert colors to newly appended rows
      newRows.forEach((_, i) => {
        const newRowIndex = startRow + i;
        const matchKey    = Object.keys(rowBuffer).filter(k => k.startsWith('new_'))[i];
        const result      = alignmentResults.find(r => `new_${_buildMatchKey(r.campaign)}` === matchKey);
        if (result) {
          _applyRowFormatting(sheet, newRowIndex, result.pacing);
        }
      });
    }

    _applyHeaderFormatting(sheet);

    utils.log(
      `updateCampaignsTab [${clientConfig.name}]: ${alignmentResults.length} campaigns written to "${tabName}"`,
      utils.LOG_LEVELS.INFO
    );

  } catch (error) {
    utils.logError(`updateCampaignsTab failed for ${clientConfig.name}`, error);
  }
}

// ---------------------------------------------------------------------------
// Private — sheet setup
// ---------------------------------------------------------------------------

/**
 * Returns the Campaigns sheet, creating it with headers if it doesn't exist.
 *
 * @param {Spreadsheet} ss
 * @param {string}      tabName
 * @returns {Sheet}
 */
function _getOrCreateCampaignsSheet(ss, tabName) {
  let sheet = ss.getSheetByName(tabName);

  if (!sheet) {
    sheet = ss.insertSheet(tabName);
    utils.log(`Created Campaigns tab: "${tabName}"`, utils.LOG_LEVELS.INFO);
  }

  // Write headers if the sheet is empty or the first cell doesn't match
  if (sheet.getLastRow() === 0 || sheet.getRange(1, 1).getValue() !== CAMPAIGNS_HEADER_ROW[0]) {
    const headerRange = sheet.getRange(1, 1, 1, CAMPAIGNS_NUM_COLS);
    headerRange.setValues([CAMPAIGNS_HEADER_ROW]);
    _applyHeaderFormatting(sheet);
    sheet.setFrozenRows(1);
    _applyColumnWidths(sheet);
  }

  return sheet;
}

/**
 * Reads all data rows and returns a map of matchKey → 1-based row index.
 * Row 1 is the header; data starts at row 2.
 *
 * @param {Sheet} sheet
 * @returns {Object}
 */
function _buildExistingRowMap(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return {};

  const data = sheet.getRange(2, 1, lastRow - 1, CAMPAIGNS_NUM_COLS).getValues();
  const map  = {};

  const siteCodeIdx     = CAMPAIGNS_COLUMNS.siteCode.index;
  const campaignTypeIdx = CAMPAIGNS_COLUMNS.campaignType.index;
  const locationIdx     = CAMPAIGNS_COLUMNS.location.index;

  data.forEach((row, i) => {
    const siteCode     = String(row[siteCodeIdx]     || '').trim();
    const campaignType = String(row[campaignTypeIdx] || '').trim();
    const location     = String(row[locationIdx]     || '').trim();
    const key = _buildMatchKeyFromParts(siteCode, location, campaignType);
    if (key) map[key] = i + 2; // +2: 1-based + skip header
  });

  return map;
}

// ---------------------------------------------------------------------------
// Private — row building
// ---------------------------------------------------------------------------

/**
 * Builds the match key for a campaign object (post-parser).
 * Prefers identifierValue (Site Code); falls back to full location string.
 *
 * @param {Object} campaign
 * @returns {string}
 */
function _buildMatchKey(campaign) {
  return _buildMatchKeyFromParts(
    campaign.identifierValue || '',
    campaign.location        || '',
    campaign.campaignType    || ''
  );
}

/**
 * @param {string} siteCode
 * @param {string} location
 * @param {string} campaignType
 * @returns {string}
 */
function _buildMatchKeyFromParts(siteCode, location, campaignType) {
  const id = siteCode.trim() || location.trim();
  return `${id}||${campaignType.trim()}`;
}

/**
 * Builds the full row data array for a campaign + pacing result.
 * The "Approved Monthly" cell is SKIPPED if the row already exists —
 * that value is owned by the Budget Input sync, not this script.
 *
 * @param {Object}  campaign
 * @param {Object}  pacing       From budget.calculatePacing()
 * @param {Object}  dates        From budget.buildDatesObject()
 * @param {Date}    now          Timestamp for Last Updated column
 * @param {Sheet}   sheet        Needed to read existing Approved Monthly if skipping
 * @param {number|undefined} existingRowIndex  1-based row index if row exists
 * @returns {{ values: Array, pacing: Object }}
 */
function _buildRowData(campaign, pacing, dates, now, sheet, existingRowIndex) {
  const c = CAMPAIGNS_COLUMNS;

  // Projected spend: implied monthly capped at approved (never exceed ceiling)
  const projectedSpend = pacing.approvedMonthly !== null
    ? Math.min(pacing.impliedMonthly || 0, pacing.approvedMonthly)
    : null;

  // Pacing %: pacingRatio as a percentage
  const pacingPct = pacing.pacingRatio !== null ? pacing.pacingRatio : null;

  // Approved Monthly: read existing cell value if row already exists —
  // this script must NEVER overwrite it.
  let approvedMonthly = pacing.approvedMonthly;
  if (existingRowIndex) {
    const existingApproved = sheet.getRange(existingRowIndex, c.approvedMonthly.index + 1).getValue();
    if (existingApproved !== '' && existingApproved !== null) {
      approvedMonthly = existingApproved; // preserve what's already there
    }
  }

  const values = new Array(CAMPAIGNS_NUM_COLS).fill('');

  values[c.siteCode.index]         = campaign.identifierValue  || '';
  values[c.location.index]         = campaign.location         || '';
  values[c.campaignType.index]     = campaign.campaignType     || '';
  values[c.campaignName.index]     = campaign.name             || '';
  values[c.status.index]           = campaign.status           || '';
  values[c.dailyBudget.index]      = campaign.currentDailyBudget !== undefined ? campaign.currentDailyBudget : '';
  values[c.impliedMonthly.index]   = pacing.impliedMonthly     !== null ? pacing.impliedMonthly   : '';
  values[c.approvedMonthly.index]  = approvedMonthly           !== null ? approvedMonthly          : '';
  values[c.variancePct.index]      = pacing.variance           !== null ? pacing.variance          : '';
  values[c.alertLevel.index]       = pacing.alertLevel         || 'unknown';
  values[c.spendMTD.index]         = pacing.spendMTD           !== null ? pacing.spendMTD          : '';
  values[c.projectedSpend.index]   = projectedSpend            !== null ? projectedSpend            : '';
  values[c.pacingPct.index]        = pacingPct                 !== null ? pacingPct                 : '';
  values[c.impressions.index]      = campaign.impressions      !== undefined ? campaign.impressions : '';
  values[c.clicks.index]           = campaign.clicks           !== undefined ? campaign.clicks      : '';
  values[c.ctr.index]              = campaign.ctr              !== undefined ? campaign.ctr         : '';
  values[c.leads.index]            = ''; // Phase 2
  values[c.cpl.index]              = ''; // Phase 2
  values[c.bidStrategy.index]      = campaign.bidStrategy      || '';
  values[c.recommendedDaily.index] = pacing.targetDaily        !== null ? pacing.targetDaily        : '';
  values[c.lastUpdated.index]      = now;

  return { values, pacing };
}

/**
 * Writes a single row and applies alert color.
 *
 * @param {Sheet}    sheet
 * @param {number}   rowIndex   1-based
 * @param {Object}   rowData    { values, pacing }
 * @param {Object[]} alignmentResults  Used to find the matching result for color
 * @param {string}   key        rowBuffer key (the numeric rowIndex as a string)
 */
function _writeRow(sheet, rowIndex, rowData, alignmentResults, key) {
  sheet.getRange(rowIndex, 1, 1, CAMPAIGNS_NUM_COLS).setValues([rowData.values]);
  _applyRowFormatting(sheet, rowIndex, rowData.pacing);
}

/**
 * Applies number formats and alert cell color to a data row.
 *
 * @param {Sheet}  sheet
 * @param {number} rowIndex  1-based
 * @param {Object} pacing    pacing result (may be a no-pacing stub)
 */
function _applyRowFormatting(sheet, rowIndex, pacing) {
  const c = CAMPAIGNS_COLUMNS;

  // Currency columns
  const currencyCols = [
    c.dailyBudget.index, c.impliedMonthly.index, c.approvedMonthly.index,
    c.spendMTD.index, c.projectedSpend.index, c.recommendedDaily.index, c.cpl.index,
  ];
  currencyCols.forEach(colIdx => {
    sheet.getRange(rowIndex, colIdx + 1).setNumberFormat('$#,##0.00');
  });

  // Percentage columns
  sheet.getRange(rowIndex, c.variancePct.index + 1).setNumberFormat('0.0%');
  sheet.getRange(rowIndex, c.pacingPct.index  + 1).setNumberFormat('0.0%');
  sheet.getRange(rowIndex, c.ctr.index        + 1).setNumberFormat('0.00%');

  // Date column
  sheet.getRange(rowIndex, c.lastUpdated.index + 1).setNumberFormat('M/d/yy h:mm am/pm');

  // Alert Level cell color — delegate to alerter
  const alertLevel = pacing ? pacing.alertLevel : 'unknown';
  alerter.flagCampaignCells(sheet, rowIndex, alertLevel);
}

// ---------------------------------------------------------------------------
// Private — formatting helpers
// ---------------------------------------------------------------------------

function _applyHeaderFormatting(sheet) {
  const headerRange = sheet.getRange(1, 1, 1, CAMPAIGNS_NUM_COLS);
  headerRange.setFontWeight('bold').setBackground('#e8eaf6').setWrap(false);
}

function _applyColumnWidths(sheet) {
  const c = CAMPAIGNS_COLUMNS;
  sheet.setColumnWidth(c.siteCode.index        + 1, 90);
  sheet.setColumnWidth(c.location.index        + 1, 180);
  sheet.setColumnWidth(c.campaignType.index    + 1, 100);
  sheet.setColumnWidth(c.campaignName.index    + 1, 260);
  sheet.setColumnWidth(c.status.index          + 1, 80);
  sheet.setColumnWidth(c.dailyBudget.index     + 1, 100);
  sheet.setColumnWidth(c.impliedMonthly.index  + 1, 120);
  sheet.setColumnWidth(c.approvedMonthly.index + 1, 130);
  sheet.setColumnWidth(c.variancePct.index     + 1, 90);
  sheet.setColumnWidth(c.alertLevel.index      + 1, 90);
  sheet.setColumnWidth(c.spendMTD.index        + 1, 100);
  sheet.setColumnWidth(c.projectedSpend.index  + 1, 120);
  sheet.setColumnWidth(c.pacingPct.index       + 1, 80);
  sheet.setColumnWidth(c.recommendedDaily.index + 1, 140);
  sheet.setColumnWidth(c.lastUpdated.index     + 1, 140);
}

// ---------------------------------------------------------------------------
// Module export
// ---------------------------------------------------------------------------

const spreadsheetUpdater = {
  updateCampaignsTab,
  CAMPAIGNS_COLUMNS,
  CAMPAIGNS_HEADER_ROW,
  ALERT_COLORS,
};
