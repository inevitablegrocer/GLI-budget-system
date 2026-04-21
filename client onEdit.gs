/**
 * GLI Budget Pacing System - Client onEdit Handler
 * Version: 2.0.0
 *
 */


function onEdit(event) {
  if (!event) return;

  const sheet   = event.range.getSheet();
  const col     = event.range.getColumn();
  const row     = event.range.getRow();
  const value   = event.range.getValue();

  if (row <= 1) return;

  // Column indices (1-based) in client approval sheet
  const APPROVED_COL      = 4; // "Recommended Budget Approved"
  const NO_ADS_COL        = 5; // "No Ads This Month"
  const APPROVAL_TS_COL   = 6; // "Approval Timestamp"
  const DISAPPROVAL_TS_COL = 7; // "Disapproval Timestamp"

  const stampMap = {
    [APPROVED_COL]:  { tsCol: APPROVAL_TS_COL,    watchVal: true },
    [NO_ADS_COL]:    { tsCol: DISAPPROVAL_TS_COL, watchVal: true }
  };

  const config = stampMap[col];
  if (!config || value !== config.watchVal) return;

  sheet.getRange(row, config.tsCol)
    .setValue(new Date())
    .setNumberFormat('dddd m/d/yy "at" hh:mm A/P".M."');
}
