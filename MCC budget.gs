/**
 * MCC budget.gs
 * GLI Budget Pacing System
 *
 * Runs in: MCC Ads Script project only (NOT in the Budget Workbook sheet project)
 *
 * Handles:
 *   - Recommended budget calculations (Patterns A, B, C)
 *   - Pacing math (targetDaily, impliedMonthly, variance)
 *   - Budget stage determination
 *   - Budget alignment validation
 *
 * Column positions in the Budget Input sheet are resolved dynamically from
 * header names at runtime — no dependency on BUDGET_INPUT_COLUMNS from
 * budgetInput.gs, which is not present in the MCC project.
 *
 * Dependencies (shared global scope in MCC project):
 *   - configManager  (config.gs)
 *   - campaignParser (campaignParser.gs)
 *   - utils          (utils.gs)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Used ONLY for impliedMonthly comparison. Never used to set actual budgets.
 * Actual target daily always uses real calendar daysRemaining.
 */
const IMPLIED_MONTHLY_FACTOR = 30.4;

/** Alert level identifiers surfaced to spreadsheetUpdater and alerter. */
const ALERT_LEVELS = {
  OK:       'ok',
  WARNING:  'warning',
  CRITICAL: 'critical',
};

/** Budget stage identifiers. */
const BUDGET_STAGE_NAMES = {
  NEW_BUDGET:   'newBudget',
  RAMPING_UP:   'rampingUp',
  STABILIZING:  'stabilizing',
  ESTABLISHED:  'established',
};

/**
 * Header names for the Budget Input sheet columns this module needs to read.
 * These must match exactly what budgetInput.gs writes as column headers.
 * Reading by name rather than position means column order changes won't break
 * the MCC script.
 */
const BUDGET_INPUT_HEADERS = {
  location:           'Location',
  campaignType:       'Campaign Type',
  authPattern:        'Auth Pattern',
  locationBudget:     'Location Monthly Budget',
  splitPct:           'Split %',
  recommendedBudget:  'Recommended Budget',
  approvedBudget:     'Approved Budget',
  noAdsCheckbox:      'No Ads This Month',
  lastMonthApproved:  'Last Month Approved',
};

// ---------------------------------------------------------------------------
// calculateRecommendedBudgets
// ---------------------------------------------------------------------------

/**
 * Reads all rows from the Budget Input sheet for the given client and
 * calculates the recommended budget for each location × campaign-type pair.
 *
 * Pattern A (percentage):
 *   recommendedBudget = locationMonthlyBudget × splitPct
 *
 * Pattern B (fixed_memory):
 *   recommendedBudget = approvedBudget (col H)
 *                    || lastMonthApproved (col O)
 *                    || fixedDefault (SplitRules)
 *
 * Pattern C (annual_override):
 *   recommendedBudget = lastMonthApproved (auto-approved; only changes in Jan)
 *
 * @param {Object} clientConfig  Full client config from configManager.getClientConfig()
 * @param {Object} dates         Date context object — see buildDatesObject()
 * @returns {Object}             Map of locationTypeKey → { recommendedBudget, authPattern, location, campaignType }
 */
function calculateRecommendedBudgets(clientConfig, dates) {
  const ss        = SpreadsheetApp.openByUrl(_getBudgetWorkbookUrl());
  const sheetName = clientConfig.budgetInputSheet;
  const sheet     = ss.getSheetByName(sheetName);

  if (!sheet) {
    utils.log(`calculateRecommendedBudgets: Budget Input sheet not found: "${sheetName}"`, utils.LOG_LEVELS.ERROR);
    return {};
  }

  const data    = sheet.getDataRange().getValues();
  const headers = data[0];

  if (!headers || headers.length === 0) {
    utils.log(`calculateRecommendedBudgets: sheet "${sheetName}" has no headers`, utils.LOG_LEVELS.ERROR);
    return {};
  }

  // Resolve column positions from header names — resilient to column reordering
  const idx = _buildSheetColumnIndex(headers, BUDGET_INPUT_HEADERS);

  const splitRules = _buildSplitRulesMap(clientConfig);
  const results    = {};

  for (let i = 1; i < data.length; i++) {
    const row = data[i];

    const location     = String(row[idx.location]     || '').trim();
    const campaignType = String(row[idx.campaignType] || '').trim();
    const authPattern  = String(row[idx.authPattern]  || '').trim();

    if (!location || !campaignType || !authPattern) continue;

    const locationMonthlyBudget = _toNumber(row[idx.locationBudget]);
    const splitPct              = _toNumber(row[idx.splitPct]);
    const approvedBudget        = _toNumber(row[idx.approvedBudget]);
    const lastMonthApproved     = _toNumber(row[idx.lastMonthApproved]);
    const noAdsThisMonth        = row[idx.noAdsCheckbox] === true;

    const key = campaignParser.buildLocationTypeKey(location, campaignType);

    if (noAdsThisMonth) {
      results[key] = _buildRecommendedBudgetResult(location, campaignType, authPattern, 0);
      continue;
    }

    let recommendedBudget = 0;

    switch (authPattern) {
      case 'percentage': {
        if (locationMonthlyBudget > 0 && splitPct > 0) {
          recommendedBudget = locationMonthlyBudget * splitPct;
        } else {
          utils.log(`Pattern A row ${i + 1} (${key}): missing locationMonthlyBudget or splitPct`, utils.LOG_LEVELS.WARNING);
        }
        break;
      }

      case 'fixed_memory': {
        if (approvedBudget > 0) {
          recommendedBudget = approvedBudget;
        } else if (lastMonthApproved > 0) {
          recommendedBudget = lastMonthApproved;
          utils.log(`Pattern B row ${i + 1} (${key}): using lastMonthApproved ${lastMonthApproved}`, utils.LOG_LEVELS.INFO);
        } else {
          const ruleDefault = _getSplitRuleFixedDefault(splitRules, campaignType);
          if (ruleDefault > 0) {
            recommendedBudget = ruleDefault;
            utils.log(`Pattern B row ${i + 1} (${key}): using SplitRules fixedDefault ${ruleDefault}`, utils.LOG_LEVELS.INFO);
          } else {
            utils.log(`Pattern B row ${i + 1} (${key}): no approved, lastMonth, or fixedDefault found`, utils.LOG_LEVELS.WARNING);
          }
        }
        break;
      }

      case 'annual_override': {
        if (lastMonthApproved > 0) {
          recommendedBudget = lastMonthApproved;
        } else {
          utils.log(`Pattern C row ${i + 1} (${key}): no lastMonthApproved — manual entry required`, utils.LOG_LEVELS.WARNING);
          recommendedBudget = approvedBudget > 0 ? approvedBudget : 0;
        }
        break;
      }

      default:
        utils.log(`Row ${i + 1} (${key}): unknown authPattern "${authPattern}" — skipping`, utils.LOG_LEVELS.WARNING);
        continue;
    }

    results[key] = _buildRecommendedBudgetResult(location, campaignType, authPattern, recommendedBudget);
  }

  utils.log(
    `calculateRecommendedBudgets: ${Object.keys(results).length} rows processed for ${clientConfig.name}`,
    utils.LOG_LEVELS.INFO
  );
  return results;
}

// ---------------------------------------------------------------------------
// calculatePacing
// ---------------------------------------------------------------------------

/**
 * Calculates pacing metrics for a single campaign against its approved monthly budget.
 *
 * @param {Object} campaign        Post-parser campaign object. Expected fields:
 *                                   name, currentDailyBudget, spendMTD,
 *                                   daysActive, location, campaignType
 * @param {Object} clientConfig    Full client config from configManager.getClientConfig()
 * @param {Object} dates           Date context from buildDatesObject()
 * @param {number} approvedMonthly Approved monthly budget for this campaign
 *
 * @returns {Object} {
 *   targetDaily     {number}   what the daily budget should be set to today
 *   currentDaily    {number}   current Google Ads daily budget
 *   impliedMonthly  {number}   currentDaily × 30.4 (comparison only — never used to set budgets)
 *   approvedMonthly {number}   hard ceiling
 *   spendMTD        {number}   spend so far this month
 *   remainingBudget {number}   approvedMonthly − spendMTD, floored at 0
 *   daysRemaining   {number}   calendar days left including today
 *   variance        {number}   (impliedMonthly − approvedMonthly) / approvedMonthly
 *   budgetStage     {string}   newBudget | rampingUp | stabilizing | established
 *   stageTolerance  {number}   variance tolerance for this stage
 *   pacingRatio     {number}   spendMTD / expectedSpendByNow
 *   isOverPacing    {boolean}
 *   isUnderPacing   {boolean}
 *   alertLevel      {string}   ok | warning | critical
 * }
 */
function calculatePacing(campaign, clientConfig, dates, approvedMonthly) {
  const currentDaily  = _toNumber(campaign.currentDailyBudget);
  const spendMTD      = _toNumber(campaign.spendMTD);
  const daysActive    = _toNumber(campaign.daysActive);
  const daysRemaining = dates.daysRemaining;
  const daysInMonth   = dates.daysInMonth;
  const dayOfMonth    = dates.dayOfMonth;

  if (!approvedMonthly || approvedMonthly <= 0) {
    utils.log(`calculatePacing: no approvedMonthly for "${campaign.name}" — skipping`, utils.LOG_LEVELS.WARNING);
    return _buildNoPacingResult(campaign, currentDaily, spendMTD);
  }

  // ── Core math ──────────────────────────────────────────────────────────────

  const remainingBudget = Math.max(approvedMonthly - spendMTD, 0);

  // targetDaily always uses real calendar days — never 30.4
  const targetDaily = daysRemaining > 0 ? remainingBudget / daysRemaining : 0;

  // impliedMonthly: comparison/flagging ONLY
  const impliedMonthly = currentDaily * IMPLIED_MONTHLY_FACTOR;

  const variance = approvedMonthly > 0
    ? (impliedMonthly - approvedMonthly) / approvedMonthly
    : 0;

  // ── Budget stage & tolerance ───────────────────────────────────────────────
  const { budgetStage, stageTolerance } = determineBudgetStage(
    daysActive, approvedMonthly, clientConfig
  );

  // ── Pacing ratio ───────────────────────────────────────────────────────────
  const daysElapsed        = dayOfMonth - 1;
  const expectedSpendByNow = daysElapsed > 0
    ? (approvedMonthly / daysInMonth) * daysElapsed
    : 0;
  const pacingRatio = expectedSpendByNow > 0 ? spendMTD / expectedSpendByNow : 1;

  // ── Over/under: use stage tolerance to suppress ramp-period false alerts ───
  const isOverPacing  = variance >  stageTolerance;
  const isUnderPacing = variance < -stageTolerance;

  // ── Alert level: use global thresholds from config ─────────────────────────
  // Keys match what config.gs loads from the Thresholds tab
  const thresholds        = clientConfig.thresholds || {};
  const warnThreshold     = _toNumber(thresholds.warningVariance)  || DEFAULT_THRESHOLDS.WARNING_VARIANCE;
  const criticalThreshold = _toNumber(thresholds.criticalVariance) || DEFAULT_THRESHOLDS.CRITICAL_VARIANCE;

  const absVariance = Math.abs(variance);
  let alertLevel = ALERT_LEVELS.OK;
  if      (absVariance >= criticalThreshold) alertLevel = ALERT_LEVELS.CRITICAL;
  else if (absVariance >= warnThreshold)     alertLevel = ALERT_LEVELS.WARNING;

  return {
    targetDaily,
    currentDaily,
    impliedMonthly,
    approvedMonthly,
    spendMTD,
    remainingBudget,
    daysRemaining,
    variance,
    budgetStage,
    stageTolerance,
    pacingRatio,
    isOverPacing,
    isUnderPacing,
    alertLevel,
  };
}

// ---------------------------------------------------------------------------
// determineBudgetStage
// ---------------------------------------------------------------------------

/**
 * Returns the budget stage and variance tolerance for a campaign based on
 * how many days have passed since its last significant budget change.
 *
 * Stages (day counts from DEFAULT_BUDGET_STAGES in config.gs):
 *   newBudget:   ≤ 3 days  → ±50%
 *   rampingUp:   ≤ 6 days  → ±30%
 *   stabilizing: ≤ 10 days → ±15%
 *   established:            → ±10% (high budget) or ±15% (standard)
 *
 * @param {number} daysActive    Days since last significant budget change
 * @param {number} monthlyBudget Approved monthly budget (for high-budget check)
 * @param {Object} clientConfig
 * @returns {{ budgetStage: string, stageTolerance: number }}
 */
function determineBudgetStage(daysActive, monthlyBudget, clientConfig) {
  const thresholds          = (clientConfig && clientConfig.thresholds)   || {};
  const stages              = (clientConfig && clientConfig.budgetStages) || {};
  const highBudgetThreshold = _toNumber(thresholds.highBudgetThreshold)   || 300;

  // Read stage day windows from config; fall back to HANDOFF defaults
  const newBudgetDays   = _toNumber((stages.newBudget   || {}).days) || 3;
  const rampingUpDays   = _toNumber((stages.rampingUp   || {}).days) || 6;
  const stabilizingDays = _toNumber((stages.stabilizing || {}).days) || 10;

  if (daysActive <= newBudgetDays)   return { budgetStage: BUDGET_STAGE_NAMES.NEW_BUDGET,   stageTolerance: 0.50 };
  if (daysActive <= rampingUpDays)   return { budgetStage: BUDGET_STAGE_NAMES.RAMPING_UP,   stageTolerance: 0.30 };
  if (daysActive <= stabilizingDays) return { budgetStage: BUDGET_STAGE_NAMES.STABILIZING,  stageTolerance: 0.15 };

  const isHighBudget   = monthlyBudget >= highBudgetThreshold;
  const stageTolerance = isHighBudget ? 0.10 : 0.15;
  return { budgetStage: BUDGET_STAGE_NAMES.ESTABLISHED, stageTolerance };
}

// ---------------------------------------------------------------------------
// validateBudgetAlignment
// ---------------------------------------------------------------------------

/**
 * Runs calculatePacing for every campaign and returns a summary.
 *
 * @param {Object}   clientConfig
 * @param {Object[]} campaigns    Parsed campaign objects from dataCollection
 * @param {Object}   dates        From buildDatesObject()
 * @returns {{
 *   results:     Object[],   pacing result per campaign
 *   hasCritical: boolean,
 *   hasWarning:  boolean,
 *   summary:     Object      counts by alertLevel
 * }}
 */
function validateBudgetAlignment(clientConfig, campaigns, dates) {
  const approvedBudgets = _readApprovedBudgets(clientConfig);

  const results     = [];
  let   hasCritical = false;
  let   hasWarning  = false;
  const summary     = { ok: 0, warning: 0, critical: 0, skipped: 0 };

  for (const campaign of campaigns) {
    const key             = campaignParser.buildLocationTypeKey(campaign.location, campaign.campaignType);
    const approvedMonthly = approvedBudgets[key];

    if (approvedMonthly === undefined || approvedMonthly === null) {
      utils.log(
        `validateBudgetAlignment: no approved budget for "${key}" (${campaign.name})`,
        utils.LOG_LEVELS.WARNING
      );
      summary.skipped++;
      results.push({
        campaign,
        pacing: _buildNoPacingResult(campaign, campaign.currentDailyBudget, campaign.spendMTD),
        key,
      });
      continue;
    }

    const pacing = calculatePacing(campaign, clientConfig, dates, approvedMonthly);

    if      (pacing.alertLevel === ALERT_LEVELS.CRITICAL) { hasCritical = true; summary.critical++; }
    else if (pacing.alertLevel === ALERT_LEVELS.WARNING)  { hasWarning  = true; summary.warning++;  }
    else                                                    summary.ok++;

    results.push({ campaign, pacing, key });
  }

  utils.log(
    `validateBudgetAlignment [${clientConfig.name}]: ` +
    `ok=${summary.ok} warn=${summary.warning} critical=${summary.critical} skipped=${summary.skipped}`,
    utils.LOG_LEVELS.INFO
  );

  return { results, hasCritical, hasWarning, summary };
}

// ---------------------------------------------------------------------------
// buildDatesObject
// ---------------------------------------------------------------------------

/**
 * Builds the dates context object used throughout pacing calculations.
 * Call once at the top of main() and pass through to all budget functions.
 *
 * @param {Date} [now]  Defaults to new Date(). Pass a fixed date for testing.
 * @returns {{
 *   today:        Date,
 *   dayOfMonth:   number,
 *   daysInMonth:  number,
 *   daysRemaining: number,  includes today
 *   monthLabel:   string,   "YYYY-MM"
 *   year:         number,
 *   month:        number,   0-indexed
 *   isJanuary:    boolean
 * }}
 */
function buildDatesObject(now) {
  const today = now ? new Date(now) : new Date();
  today.setHours(0, 0, 0, 0);

  const year       = today.getFullYear();
  const month      = today.getMonth();
  const dayOfMonth = today.getDate();
  const daysInMonth  = new Date(year, month + 1, 0).getDate();
  const daysRemaining = daysInMonth - dayOfMonth + 1;
  const monthLabel    = `${year}-${String(month + 1).padStart(2, '0')}`;

  return { today, dayOfMonth, daysInMonth, daysRemaining, monthLabel, year, month, isJanuary: month === 0 };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Reads column positions from a header row by matching against a map of
 * { key: headerName } pairs. Returns { key: columnIndex } (0-based).
 * Logs a warning for any header name not found.
 *
 * @param {string[]} headers    First row of sheet data
 * @param {Object}   headerMap  { key: 'Exact Column Header Name' }
 * @returns {Object}            { key: index }
 */
function _buildSheetColumnIndex(headers, headerMap) {
  const idx = {};
  for (const [key, headerName] of Object.entries(headerMap)) {
    const i = headers.indexOf(headerName);
    if (i === -1) {
      utils.log(`_buildSheetColumnIndex: column "${headerName}" not found in sheet`, utils.LOG_LEVELS.WARNING);
    }
    idx[key] = i; // -1 means not found; reads on row[−1] return undefined → _toNumber gives 0
  }
  return idx;
}

/**
 * Reads Approved Budget column from Budget Input for every row.
 * Returns map of locationTypeKey → approvedBudget.
 *
 * @param {Object} clientConfig
 * @returns {Object}
 */
function _readApprovedBudgets(clientConfig) {
  const ss        = SpreadsheetApp.openByUrl(_getBudgetWorkbookUrl());
  const sheetName = clientConfig.budgetInputSheet;
  const sheet     = ss.getSheetByName(sheetName);

  if (!sheet) {
    utils.log(`_readApprovedBudgets: sheet "${sheetName}" not found`, utils.LOG_LEVELS.ERROR);
    return {};
  }

  const data    = sheet.getDataRange().getValues();
  const headers = data[0];
  const idx     = _buildSheetColumnIndex(headers, BUDGET_INPUT_HEADERS);
  const result  = {};

  for (let i = 1; i < data.length; i++) {
    const row          = data[i];
    const location     = String(row[idx.location]     || '').trim();
    const campaignType = String(row[idx.campaignType] || '').trim();
    const approved     = _toNumber(row[idx.approvedBudget]);

    if (!location || !campaignType) continue;

    result[campaignParser.buildLocationTypeKey(location, campaignType)] = approved;
  }

  return result;
}

/**
 * Builds a map of campaignType → split rule from clientConfig.splitRules.
 * splitRules is an object keyed by campaignType (set by config.gs).
 *
 * @param {Object} clientConfig
 * @returns {Object}  campaignType → { authPattern, splitPct, fixedDefault }
 */
function _buildSplitRulesMap(clientConfig) {
  const rules      = {};
  const splitRules = (clientConfig && clientConfig.splitRules) || {};

  // config.gs stores splitRules as { campaignType: { campaignType, authPattern, splitPercentage, fixedDefault } }
  for (const [type, rule] of Object.entries(splitRules)) {
    if (!type) continue;
    rules[type] = {
      authPattern:  rule.authPattern,
      splitPct:     _toNumber(rule.splitPercentage), // note: config.gs key is splitPercentage
      fixedDefault: _toNumber(rule.fixedDefault),
    };
  }
  return rules;
}

/**
 * @param {Object} splitRulesMap
 * @param {string} campaignType
 * @returns {number}
 */
function _getSplitRuleFixedDefault(splitRulesMap, campaignType) {
  const rule = splitRulesMap[campaignType];
  return rule ? _toNumber(rule.fixedDefault) : 0;
}

/**
 * @param {string} location
 * @param {string} campaignType
 * @param {string} authPattern
 * @param {number} recommendedBudget
 * @returns {Object}
 */
function _buildRecommendedBudgetResult(location, campaignType, authPattern, recommendedBudget) {
  return {
    location,
    campaignType,
    authPattern,
    recommendedBudget: Math.round(recommendedBudget * 100) / 100,
  };
}

/**
 * Stub pacing result for campaigns that can't be evaluated.
 */
function _buildNoPacingResult(campaign, currentDaily, spendMTD) {
  return {
    targetDaily:     null,
    currentDaily:    _toNumber(currentDaily),
    impliedMonthly:  null,
    approvedMonthly: null,
    spendMTD:        _toNumber(spendMTD),
    remainingBudget: null,
    daysRemaining:   null,
    variance:        null,
    budgetStage:     null,
    stageTolerance:  null,
    pacingRatio:     null,
    isOverPacing:    false,
    isUnderPacing:   false,
    alertLevel:      ALERT_LEVELS.OK,
  };
}

/**
 * Safely coerces any value to a number; returns 0 for null/undefined/NaN/blank.
 * @param {*} val
 * @returns {number}
 */
function _toNumber(val) {
  if (val === null || val === undefined || val === '') return 0;
  const n = Number(val);
  return isNaN(n) ? 0 : n;
}

/**
 * Returns the agency Budget Workbook URL.
 * AGENCY_BUDGET_URL is a top-level const in config.gs — same global scope.
 */
function _getBudgetWorkbookUrl() {
  if (typeof AGENCY_BUDGET_URL !== 'undefined') return AGENCY_BUDGET_URL;
  throw new Error('budget.gs: AGENCY_BUDGET_URL is not defined. Check config.gs.');
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Sanity-check for calculatePacing math.
 * Run manually from the Ads Scripts editor — no live sheet access needed.
 */
function testPacingMath() {
  const dates = buildDatesObject(new Date('2025-08-15'));

  const mockClientConfig = {
    name: 'Test Client',
    thresholds: {
      warningVariance:      0.20,  // keys match config.gs Thresholds tab loader
      criticalVariance:     0.50,
      highBudgetThreshold:  300,
    },
    budgetStages: {
      newBudget:   { days: 3  },
      rampingUp:   { days: 6  },
      stabilizing: { days: 10 },
    },
  };

  const mockCampaign = {
    name:               'GLI - WA - Puyallup Meridian (Search)',
    currentDailyBudget: 50,
    spendMTD:           650,
    daysActive:         20,
    location:           'WA - Puyallup Meridian',
    campaignType:       'Search',
  };

  const approvedMonthly = 1500;
  const result = calculatePacing(mockCampaign, mockClientConfig, dates, approvedMonthly);

  Logger.log('=== testPacingMath ===');
  Logger.log('dayOfMonth=%s  daysInMonth=%s  daysRemaining=%s', dates.dayOfMonth, dates.daysInMonth, dates.daysRemaining);
  Logger.log('approvedMonthly=%s  spendMTD=%s  remainingBudget=%s', approvedMonthly, mockCampaign.spendMTD, result.remainingBudget);
  Logger.log('targetDaily=%s  currentDaily=%s  impliedMonthly=%s', result.targetDaily.toFixed(2), result.currentDaily, result.impliedMonthly.toFixed(2));
  Logger.log('variance=%s%%  stage=%s (±%s%%)  alertLevel=%s', (result.variance * 100).toFixed(1), result.budgetStage, (result.stageTolerance * 100), result.alertLevel);
  Logger.log('pacingRatio=%s  isOverPacing=%s  isUnderPacing=%s', result.pacingRatio.toFixed(3), result.isOverPacing, result.isUnderPacing);
}

/**
 * Tests determineBudgetStage across all boundary conditions.
 */
function testBudgetStages() {
  const mockConfig = {
    thresholds:   { highBudgetThreshold: 300 },
    budgetStages: {
      newBudget:   { days: 3  },
      rampingUp:   { days: 6  },
      stabilizing: { days: 10 },
    },
  };

  const cases = [
    { daysActive: 0,  budget: 200, expected: 'newBudget'   },
    { daysActive: 3,  budget: 200, expected: 'newBudget'   },
    { daysActive: 4,  budget: 200, expected: 'rampingUp'   },
    { daysActive: 6,  budget: 200, expected: 'rampingUp'   },
    { daysActive: 7,  budget: 200, expected: 'stabilizing' },
    { daysActive: 10, budget: 200, expected: 'stabilizing' },
    { daysActive: 11, budget: 200, expected: 'established' },
    { daysActive: 11, budget: 500, expected: 'established' },
  ];

  Logger.log('=== testBudgetStages ===');
  for (const c of cases) {
    const { budgetStage, stageTolerance } = determineBudgetStage(c.daysActive, c.budget, mockConfig);
    const pass = budgetStage === c.expected;
    Logger.log('[%s] daysActive=%s budget=%s → stage=%s tolerance=±%s%%',
      pass ? 'PASS' : 'FAIL', c.daysActive, c.budget, budgetStage, stageTolerance * 100);
  }
}

// ---------------------------------------------------------------------------
// Module export
// ---------------------------------------------------------------------------

const budget = {
  calculateRecommendedBudgets,
  calculatePacing,
  determineBudgetStage,
  validateBudgetAlignment,
  buildDatesObject,
  ALERT_LEVELS,
  BUDGET_STAGE_NAMES,
};
