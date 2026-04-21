/**
 * budget.gs
 * GLI Budget Pacing System
 *
 * Handles:
 *   - Recommended budget calculations (Patterns A, B, C)
 *   - Pacing math (targetDaily, impliedMonthly, variance)
 *   - Budget stage determination
 *   - Budget alignment validation
 *
 * Dependencies (shared global scope):
 *   - configManager  (config.gs)
 *   - campaignParser (campaignParser.gs)
 *   - utils          (utils.gs)
 *
 * No imports needed — all .gs files share a single Apps Script global scope.
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

/** Budget stage identifiers and their day-count windows. */
const BUDGET_STAGE_NAMES = {
  NEW_BUDGET:   'newBudget',
  RAMPING_UP:   'rampingUp',
  STABILIZING:  'stabilizing',
  ESTABLISHED:  'established',
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
 *                    || lastMonthApproved (col O / LASTMONTHBUDGET)
 *                    || fixedDefault (SplitRules)
 *
 * Pattern C (annual_override):
 *   recommendedBudget = lastMonthApproved (auto-approved; only changes in Jan)
 *
 * @param {Object} clientConfig  Full client config from configManager.getClientConfig()
 * @param {Object} dates         Date context object — see _buildDatesObject()
 * @returns {Object}             Map of locationTypeKey → { recommendedBudget, authPattern, location, campaignType }
 */
function calculateRecommendedBudgets(clientConfig, dates) {
  const ss = SpreadsheetApp.openByUrl(clientConfig.budgetInputSheetUrl || _getBudgetWorkbookUrl());
  const sheetName = clientConfig.agencySheetName + ' - Budget Input';
  const sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    utils.log('ERROR', `Budget Input sheet not found: "${sheetName}"`);
    return {};
  }

  const cols = BUDGET_INPUT_COLUMNS; // defined in budgetInput.gs, shared global scope
  const data  = sheet.getDataRange().getValues();
  const headers = data[0];

  if (!headers || headers.length === 0) {
    utils.log('ERROR', `Budget Input sheet "${sheetName}" has no headers.`);
    return {};
  }

  const splitRules = _buildSplitRulesMap(clientConfig);
  const results    = {};

  // Start at row index 1 to skip header
  for (let i = 1; i < data.length; i++) {
    const row = data[i];

    const location     = String(row[cols.LOCATION - 1]     || '').trim();
    const campaignType = String(row[cols.CAMPAIGN_TYPE - 1]|| '').trim();
    const authPattern  = String(row[cols.AUTH_PATTERN - 1] || '').trim();

    // Skip blank or incomplete rows
    if (!location || !campaignType || !authPattern) continue;

    const locationMonthlyBudget = _toNumber(row[cols.LOCATION_MONTHLY_BUDGET - 1]);
    const splitPct              = _toNumber(row[cols.SPLIT_PCT - 1]);
    const approvedBudget        = _toNumber(row[cols.APPROVED_BUDGET - 1]);
    const lastMonthApproved     = _toNumber(row[cols.LAST_MONTH_APPROVED - 1]);
    const noAdsThisMonth        = Boolean(row[cols.NO_ADS_THIS_MONTH - 1]);

    const key = campaignParser.buildLocationTypeKey(location, campaignType);

    // Campaigns flagged "No Ads This Month" always get 0
    if (noAdsThisMonth) {
      results[key] = _buildRecommendedBudgetResult(location, campaignType, authPattern, 0);
      continue;
    }

    let recommendedBudget = 0;

    switch (authPattern) {
      case 'percentage': {
        // Pattern A: straight percentage split of location monthly budget
        if (locationMonthlyBudget > 0 && splitPct > 0) {
          recommendedBudget = locationMonthlyBudget * splitPct;
        } else {
          utils.log('WARN', `Pattern A row ${i + 1} (${key}): missing locationMonthlyBudget or splitPct`);
        }
        break;
      }

      case 'fixed_memory': {
        // Pattern B: prefer current approved budget, fall back to last month, then SplitRules fixed default
        if (approvedBudget > 0) {
          recommendedBudget = approvedBudget;
        } else if (lastMonthApproved > 0) {
          recommendedBudget = lastMonthApproved;
          utils.log('INFO', `Pattern B row ${i + 1} (${key}): using lastMonthApproved ${lastMonthApproved}`);
        } else {
          const ruleDefault = _getSplitRuleFixedDefault(splitRules, campaignType);
          if (ruleDefault > 0) {
            recommendedBudget = ruleDefault;
            utils.log('INFO', `Pattern B row ${i + 1} (${key}): using SplitRules fixedDefault ${ruleDefault}`);
          } else {
            utils.log('WARN', `Pattern B row ${i + 1} (${key}): no approved, lastMonth, or fixedDefault found`);
          }
        }
        break;
      }

      case 'annual_override': {
        // Pattern C: set in January, auto-approved each subsequent month unless amount changes
        if (lastMonthApproved > 0) {
          recommendedBudget = lastMonthApproved;
        } else {
          // First month of cycle — must be set manually; warn but don't error
          utils.log('WARN', `Pattern C row ${i + 1} (${key}): no lastMonthApproved for annual_override — manual entry required`);
          recommendedBudget = approvedBudget > 0 ? approvedBudget : 0;
        }
        break;
      }

      default:
        utils.log('WARN', `Row ${i + 1} (${key}): unknown authPattern "${authPattern}" — skipping`);
        continue;
    }

    results[key] = _buildRecommendedBudgetResult(location, campaignType, authPattern, recommendedBudget);
  }

  utils.log('INFO', `calculateRecommendedBudgets: ${Object.keys(results).length} rows processed for ${clientConfig.clientName}`);
  return results;
}

// ---------------------------------------------------------------------------
// calculatePacing
// ---------------------------------------------------------------------------

/**
 * Calculates pacing metrics for a single campaign against its approved monthly budget.
 *
 * @param {Object} campaign      Campaign object (post-parser). Expected fields:
 *                                 campaignName, currentDailyBudget, spendMTD,
 *                                 daysActive (days since last budget change),
 *                                 location, campaignType
 * @param {Object} clientConfig  Full client config from configManager.getClientConfig()
 * @param {Object} dates         Date context object — see _buildDatesObject()
 * @param {number} approvedMonthly  Approved monthly budget for this campaign (from Budget Input)
 *
 * @returns {Object} {
 *   targetDaily        {number}  — what the daily budget should be set to today
 *   currentDaily       {number}  — current Google Ads daily budget
 *   impliedMonthly     {number}  — currentDaily × 30.4 (comparison only)
 *   approvedMonthly    {number}  — the hard ceiling
 *   spendMTD           {number}  — spend so far this month
 *   daysRemaining      {number}  — calendar days left including today
 *   variance           {number}  — (impliedMonthly - approvedMonthly) / approvedMonthly
 *   budgetStage        {string}  — newBudget | rampingUp | stabilizing | established
 *   stageTolerance     {number}  — variance tolerance for this stage (e.g. 0.20 = 20%)
 *   pacingRatio        {number}  — spendMTD / expectedSpendByNow
 *   isOverPacing       {boolean}
 *   isUnderPacing      {boolean}
 *   alertLevel         {string}  — ok | warning | critical
 * }
 */
function calculatePacing(campaign, clientConfig, dates, approvedMonthly) {
  const currentDaily   = _toNumber(campaign.currentDailyBudget);
  const spendMTD       = _toNumber(campaign.spendMTD);
  const daysActive     = _toNumber(campaign.daysActive);
  const daysRemaining  = dates.daysRemaining;
  const daysInMonth    = dates.daysInMonth;
  const dayOfMonth     = dates.dayOfMonth;

  // Guard: if no approved budget, we can't pace
  if (!approvedMonthly || approvedMonthly <= 0) {
    utils.log('WARN', `calculatePacing: no approvedMonthly for ${campaign.campaignName} — skipping`);
    return _buildNoPacingResult(campaign, currentDaily, spendMTD);
  }

  // ── Core math ──────────────────────────────────────────────────────────────

  // Hard ceiling: never let remaining budget go negative
  const remainingBudget = Math.max(approvedMonthly - spendMTD, 0);

  // targetDaily uses real calendar days remaining — never 30.4
  const targetDaily = daysRemaining > 0 ? remainingBudget / daysRemaining : 0;

  // impliedMonthly is for comparison/flagging ONLY — never used to set a budget
  const impliedMonthly = currentDaily * IMPLIED_MONTHLY_FACTOR;

  // Variance: how far off is our current pace from approved?
  const variance = approvedMonthly > 0
    ? (impliedMonthly - approvedMonthly) / approvedMonthly
    : 0;

  // ── Budget stage & tolerance ───────────────────────────────────────────────
  const { budgetStage, stageTolerance } = determineBudgetStage(
    daysActive,
    approvedMonthly,
    clientConfig
  );

  // ── Pacing ratio ───────────────────────────────────────────────────────────
  // Compare actual spend to what we'd expect if we'd been spending evenly
  const daysElapsed         = dayOfMonth - 1; // days fully completed before today
  const expectedSpendByNow  = daysElapsed > 0
    ? (approvedMonthly / daysInMonth) * daysElapsed
    : 0;
  const pacingRatio = expectedSpendByNow > 0
    ? spendMTD / expectedSpendByNow
    : 1; // no days elapsed yet → treat as on track

  // ── Over/under determination ───────────────────────────────────────────────
  // Use stage-specific tolerance, not hard thresholds, to avoid false alerts
  // during budget ramp periods
  const isOverPacing  = variance > stageTolerance;
  const isUnderPacing = variance < -stageTolerance;

  // ── Alert level ────────────────────────────────────────────────────────────
  const thresholds = clientConfig.thresholds || {};
  const warnThreshold     = _toNumber(thresholds.warningVariancePct)  || 0.20;
  const criticalThreshold = _toNumber(thresholds.criticalVariancePct) || 0.50;

  const absVariance = Math.abs(variance);
  let alertLevel = ALERT_LEVELS.OK;
  if (absVariance >= criticalThreshold) {
    alertLevel = ALERT_LEVELS.CRITICAL;
  } else if (absVariance >= warnThreshold) {
    alertLevel = ALERT_LEVELS.WARNING;
  }

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
 * Returns the budget stage and its associated variance tolerance based on
 * how many days have passed since the last significant budget change.
 *
 * Stages:
 *   newBudget:   ≤ 3 days  → ±50%
 *   rampingUp:   ≤ 6 days  → ±30%
 *   stabilizing: ≤ 10 days → ±15%
 *   established:            → ±10% (high budget) or ±15% (standard)
 *
 * High budget threshold: clientConfig.thresholds.highBudgetThreshold (default $300/month)
 *
 * @param {number} daysActive     Days since last significant budget change
 * @param {number} monthlyBudget  The approved monthly budget (for high-budget check)
 * @param {Object} clientConfig
 * @returns {{ budgetStage: string, stageTolerance: number }}
 */
function determineBudgetStage(daysActive, monthlyBudget, clientConfig) {
  const thresholds        = (clientConfig && clientConfig.thresholds) || {};
  const highBudgetThreshold = _toNumber(thresholds.highBudgetThreshold) || 300;

  const stages = (clientConfig && clientConfig.budgetStages) || {};

  // Fall back to HANDOFF-specified defaults if configManager didn't supply them
  const newBudgetDays   = _toNumber(stages.newBudgetDays)   || 3;
  const rampingUpDays   = _toNumber(stages.rampingUpDays)   || 6;
  const stabilizingDays = _toNumber(stages.stabilizingDays) || 10;

  if (daysActive <= newBudgetDays) {
    return { budgetStage: BUDGET_STAGE_NAMES.NEW_BUDGET, stageTolerance: 0.50 };
  }
  if (daysActive <= rampingUpDays) {
    return { budgetStage: BUDGET_STAGE_NAMES.RAMPING_UP, stageTolerance: 0.30 };
  }
  if (daysActive <= stabilizingDays) {
    return { budgetStage: BUDGET_STAGE_NAMES.STABILIZING, stageTolerance: 0.15 };
  }

  // Established — tighter tolerance for high-budget campaigns
  const isHighBudget  = monthlyBudget >= highBudgetThreshold;
  const stageTolerance = isHighBudget ? 0.10 : 0.15;
  return { budgetStage: BUDGET_STAGE_NAMES.ESTABLISHED, stageTolerance };
}

// ---------------------------------------------------------------------------
// validateBudgetAlignment
// ---------------------------------------------------------------------------

/**
 * Validates budget alignment across all campaigns for a client.
 * Compares each campaign's pacing against its approved monthly budget.
 *
 * @param {Object}   clientConfig  Full client config
 * @param {Object[]} campaigns     Array of parsed campaign objects (post-dataCollection + campaignParser)
 * @param {Object}   dates         Date context — see _buildDatesObject()
 * @returns {Object} {
 *   results       {Object[]}  — array of pacing results with campaign info attached
 *   hasCritical   {boolean}
 *   hasWarning    {boolean}
 *   summary       {Object}    — counts by alertLevel
 * }
 */
function validateBudgetAlignment(clientConfig, campaigns, dates) {
  // Read current approved budgets from Budget Input sheet
  const approvedBudgets = _readApprovedBudgets(clientConfig);

  const results     = [];
  let   hasCritical = false;
  let   hasWarning  = false;
  const summary     = { ok: 0, warning: 0, critical: 0, skipped: 0 };

  for (const campaign of campaigns) {
    const key             = campaignParser.buildLocationTypeKey(campaign.location, campaign.campaignType);
    const approvedMonthly = approvedBudgets[key];

    if (approvedMonthly === undefined || approvedMonthly === null) {
      utils.log('WARN', `validateBudgetAlignment: no approved budget for key "${key}" (${campaign.campaignName})`);
      summary.skipped++;
      results.push({
        campaign,
        pacing: _buildNoPacingResult(campaign, campaign.currentDailyBudget, campaign.spendMTD),
        key,
      });
      continue;
    }

    const pacing = calculatePacing(campaign, clientConfig, dates, approvedMonthly);

    if (pacing.alertLevel === ALERT_LEVELS.CRITICAL) {
      hasCritical = true;
      summary.critical++;
    } else if (pacing.alertLevel === ALERT_LEVELS.WARNING) {
      hasWarning = true;
      summary.warning++;
    } else {
      summary.ok++;
    }

    results.push({ campaign, pacing, key });
  }

  utils.log('INFO',
    `validateBudgetAlignment [${clientConfig.clientName}]: ` +
    `ok=${summary.ok} warn=${summary.warning} critical=${summary.critical} skipped=${summary.skipped}`
  );

  return { results, hasCritical, hasWarning, summary };
}

// ---------------------------------------------------------------------------
// _buildDatesObject  (exported for use by main.gs and callers)
// ---------------------------------------------------------------------------

/**
 * Builds the dates context object used throughout pacing calculations.
 * Call once per execution and pass the result through to all budget functions.
 *
 * @param {Date} [now]  Defaults to new Date(). Pass a mock date for testing.
 * @returns {Object} {
 *   today         {Date}    — current date (time zeroed)
 *   dayOfMonth    {number}  — 1-based day of month
 *   daysInMonth   {number}  — total days in the current calendar month
 *   daysRemaining {number}  — days left including today
 *   monthLabel    {string}  — e.g. "2025-08"
 *   year          {number}
 *   month         {number}  — 0-indexed (JS Date convention)
 *   isJanuary     {boolean} — used for annual_override logic
 * }
 */
function buildDatesObject(now) {
  const today      = now ? new Date(now) : new Date();
  today.setHours(0, 0, 0, 0);

  const year       = today.getFullYear();
  const month      = today.getMonth(); // 0-indexed
  const dayOfMonth = today.getDate();

  // Last day of the current month
  const lastDay    = new Date(year, month + 1, 0);
  const daysInMonth = lastDay.getDate();

  // daysRemaining includes today
  const daysRemaining = daysInMonth - dayOfMonth + 1;

  const monthLabel = `${year}-${String(month + 1).padStart(2, '0')}`;

  return {
    today,
    dayOfMonth,
    daysInMonth,
    daysRemaining,
    monthLabel,
    year,
    month,
    isJanuary: month === 0,
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Reads the Approved Budget column (col H) from Budget Input for every row.
 * Returns map of locationTypeKey → approvedBudget.
 * Used internally by validateBudgetAlignment.
 *
 * @param {Object} clientConfig
 * @returns {Object}
 */
function _readApprovedBudgets(clientConfig) {
  const ss = SpreadsheetApp.openByUrl(clientConfig.budgetInputSheetUrl || _getBudgetWorkbookUrl());
  const sheetName = clientConfig.agencySheetName + ' - Budget Input';
  const sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    utils.log('ERROR', `_readApprovedBudgets: sheet "${sheetName}" not found`);
    return {};
  }

  const cols = BUDGET_INPUT_COLUMNS;
  const data  = sheet.getDataRange().getValues();
  const result = {};

  for (let i = 1; i < data.length; i++) {
    const row          = data[i];
    const location     = String(row[cols.LOCATION - 1]      || '').trim();
    const campaignType = String(row[cols.CAMPAIGN_TYPE - 1] || '').trim();
    const approved     = _toNumber(row[cols.APPROVED_BUDGET - 1]);

    if (!location || !campaignType) continue;

    const key = campaignParser.buildLocationTypeKey(location, campaignType);
    result[key] = approved;
  }

  return result;
}

/**
 * Builds a map of campaignType → split rule from clientConfig.splitRules array.
 * SplitRules rows are filtered to this client's accountId by configManager already.
 *
 * @param {Object} clientConfig
 * @returns {Object}  campaignType → { authPattern, splitPct, fixedDefault }
 */
function _buildSplitRulesMap(clientConfig) {
  const rules = {};
  const splitRules = (clientConfig && clientConfig.splitRules) || [];

  for (const rule of splitRules) {
    const type = String(rule.campaignType || '').trim();
    if (!type) continue;
    rules[type] = {
      authPattern:  rule.authPattern,
      splitPct:     _toNumber(rule.splitPct),
      fixedDefault: _toNumber(rule.fixedDefault),
    };
  }
  return rules;
}

/**
 * Returns the fixedDefault from SplitRules for a given campaign type.
 *
 * @param {Object} splitRulesMap  Output of _buildSplitRulesMap
 * @param {string} campaignType
 * @returns {number}
 */
function _getSplitRuleFixedDefault(splitRulesMap, campaignType) {
  const rule = splitRulesMap[campaignType];
  return rule ? _toNumber(rule.fixedDefault) : 0;
}

/**
 * Constructs the result object for calculateRecommendedBudgets.
 */
function _buildRecommendedBudgetResult(location, campaignType, authPattern, recommendedBudget) {
  return {
    location,
    campaignType,
    authPattern,
    recommendedBudget: Math.round(recommendedBudget * 100) / 100, // round to cents
  };
}

/**
 * Returns a stub pacing result for campaigns that can't be evaluated
 * (missing approved budget, no ads this month, etc.)
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
    alertLevel:      ALERT_LEVELS.OK, // don't alert on campaigns we can't evaluate
  };
}

/**
 * Safely parses a value to a number. Returns 0 for null/undefined/NaN/blank.
 *
 * @param {*} val
 * @returns {number}
 */
function _toNumber(val) {
  if (val === null || val === undefined || val === '') return 0;
  const n = Number(val);
  return isNaN(n) ? 0 : n;
}

/**
 * Returns the budget workbook URL from config.
 * Falls back to the AGENCY_BUDGET_URL constant defined in config.gs.
 */
function _getBudgetWorkbookUrl() {
  // AGENCY_BUDGET_URL is a top-level const in config.gs — shared global scope
  if (typeof AGENCY_BUDGET_URL !== 'undefined') return AGENCY_BUDGET_URL;
  throw new Error('budget.gs: AGENCY_BUDGET_URL is not defined. Check config.gs.');
}

// ---------------------------------------------------------------------------
// Diagnostics — run from Apps Script editor
// ---------------------------------------------------------------------------

/**
 * Quick sanity check for calculatePacing math.
 * Run manually from the Apps Script editor.
 */
function testPacingMath() {
  const dates = buildDatesObject(new Date('2025-08-15'));

  const mockClientConfig = {
    clientName: 'Test Client',
    thresholds: {
      warningVariancePct:  0.20,
      criticalVariancePct: 0.50,
      highBudgetThreshold: 300,
    },
    budgetStages: {
      newBudgetDays:   3,
      rampingUpDays:   6,
      stabilizingDays: 10,
    },
  };

  const mockCampaign = {
    campaignName:       'GLI - WA - Puyallup Meridian (Search)',
    currentDailyBudget: 50,  // $50/day
    spendMTD:           650, // $650 spent so far
    daysActive:         20,  // established budget
    location:           'WA - Puyallup Meridian',
    campaignType:       'Search',
  };

  const approvedMonthly = 1500;

  const result = calculatePacing(mockCampaign, mockClientConfig, dates, approvedMonthly);

  Logger.log('=== testPacingMath ===');
  Logger.log('dates: dayOfMonth=%s, daysInMonth=%s, daysRemaining=%s',
    dates.dayOfMonth, dates.daysInMonth, dates.daysRemaining);
  Logger.log('approvedMonthly: %s', approvedMonthly);
  Logger.log('spendMTD: %s', mockCampaign.spendMTD);
  Logger.log('remainingBudget: %s', result.remainingBudget);
  Logger.log('targetDaily: %s', result.targetDaily.toFixed(2));
  Logger.log('currentDaily: %s', result.currentDaily);
  Logger.log('impliedMonthly: %s', result.impliedMonthly.toFixed(2));
  Logger.log('variance: %s%%', (result.variance * 100).toFixed(1));
  Logger.log('budgetStage: %s (tolerance ±%s%%)', result.budgetStage, (result.stageTolerance * 100));
  Logger.log('pacingRatio: %s', result.pacingRatio.toFixed(3));
  Logger.log('alertLevel: %s', result.alertLevel);
  Logger.log('isOverPacing: %s | isUnderPacing: %s', result.isOverPacing, result.isUnderPacing);
}

/**
 * Tests determineBudgetStage across all stage boundaries.
 * Run manually from the Apps Script editor.
 */
function testBudgetStages() {
  const mockConfig = {
    thresholds:   { highBudgetThreshold: 300 },
    budgetStages: { newBudgetDays: 3, rampingUpDays: 6, stabilizingDays: 10 },
  };

  const cases = [
    { daysActive: 0,  budget: 200, expected: 'newBudget'   },
    { daysActive: 3,  budget: 200, expected: 'newBudget'   },
    { daysActive: 4,  budget: 200, expected: 'rampingUp'   },
    { daysActive: 6,  budget: 200, expected: 'rampingUp'   },
    { daysActive: 7,  budget: 200, expected: 'stabilizing' },
    { daysActive: 10, budget: 200, expected: 'stabilizing' },
    { daysActive: 11, budget: 200, expected: 'established' },
    { daysActive: 11, budget: 500, expected: 'established' }, // high budget → tighter tolerance
  ];

  Logger.log('=== testBudgetStages ===');
  for (const c of cases) {
    const { budgetStage, stageTolerance } = determineBudgetStage(c.daysActive, c.budget, mockConfig);
    const pass = budgetStage === c.expected;
    Logger.log('[%s] daysActive=%s budget=%s → stage=%s tolerance=±%s%%',
      pass ? 'PASS' : 'FAIL', c.daysActive, c.budget, budgetStage, (stageTolerance * 100));
  }
}

// ---------------------------------------------------------------------------
// Module export  (Apps Script shared global scope — other files call budget.fn)
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
