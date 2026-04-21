/**
 * GLI Budget Pacing System - Configuration Module
 * Version: 2.1.0
 *
 * Two source workbooks:
 *   AGENCY_CONFIG_URL  — locked, senior AM + dev only
 *   AGENCY_BUDGET_URL  — editable by account managers
 *
 * Config workbook tabs: Clients | SplitRules | Thresholds | Locations
 * Budget workbook tabs: [Client] - Budget Input | [Client] - Campaigns | [Client] - Budget History
 */

// ─── Workbook URLs ────────────────────────────────────────────────────────────

const AGENCY_CONFIG_URL = 'https://docs.google.com/spreadsheets/d/1wbendlP097_thluHa1hJtTFkacQ7eEYknAg5qdxQGXU/edit?gid=6446832#gid=6446832';
const AGENCY_BUDGET_URL = 'Yhttps://docs.google.com/spreadsheets/d/1Vvq5p4vuvuFNkxdqn0whOlkClEBTzmssHMGvuTlSrdY/edit?gid=0#gid=0';
const AGENCY_PREFIX     = 'GLI - ';

// ─── Constants ────────────────────────────────────────────────────────────────

const BUDGET_CYCLES = {
  MONTHLY:   'monthly',
  ANNUAL:    'annual',
  QUARTERLY: 'quarterly'
};

const AUTHORIZATION_PATTERNS = {
  PERCENTAGE:      'percentage',
  FIXED_MEMORY:    'fixed_memory',
  ANNUAL_OVERRIDE: 'annual_override'
};

const DEFAULT_THRESHOLDS = {
  WARNING_VARIANCE:  0.20,
  CRITICAL_VARIANCE: 0.50,
  MIN_DAILY_BUDGET:  0.01,
  MAX_PACING_PCT:    10.0,
  SPEND_GAP_HOURS:   48,
  VELOCITY_WINDOW:   3
};

const DEFAULT_BUDGET_STAGES = {
  newBudget:   { days: 3,  min: 0.50, max: 1.50 },
  rampingUp:   { days: 6,  min: 0.70, max: 1.30 },
  stabilizing: { days: 10, min: 0.85, max: 1.15 },
  established: {
    highBudget: { threshold: 300, min: 0.90, max: 1.10 },
    standard:   {               min: 0.85, max: 1.15 }
  }
};

// ─── Column Maps ──────────────────────────────────────────────────────────────

const CLIENTS_COLUMNS = {
  accountId:           'Account ID',
  clientName:          'Client Name',
  agencySheetName:     'Agency Sheet Name',
  budgetInputSheet:    'Budget Input Sheet',
  clientWorkbookUrl:   'Client Workbook URL',
  accountManagerEmail: 'Account Manager Email',
  budgetCycle:         'Budget Cycle',
  annualStartMonth:    'Annual Start Month',
  highBudgetThreshold: 'High Budget Threshold',
  brandPrefixRegex:    'Brand Prefix Regex',
  campaignTypeRegex:   'Campaign Type Regex',
  isActive:            'Active'
};

const SPLIT_RULES_COLUMNS = {
  accountId:       'Account ID',
  campaignType:    'Campaign Type',
  authPattern:     'Auth Pattern',
  splitPercentage: 'Split %',
  fixedDefault:    'Fixed Default $',
  notes:           'Notes'
};

const THRESHOLDS_COLUMNS = {
  accountId:        'Account ID',
  warningVariance:  'Warning Variance %',
  criticalVariance: 'Critical Variance %',
  minDailyBudget:   'Min Daily Budget',
  velocityWindow:   'Velocity Window Days'
};

const LOCATIONS_COLUMNS = {
  accountId:       'Account ID',
  identifierLabel: 'Location Identifier Label',
  identifierValue: 'Identifier Value',
  state:           'State',
  facilityName:    'Facility Name',
  fullLocation:    'Full Location',
  notes:           'Notes'
};

// ─── Main Config Loader ───────────────────────────────────────────────────────

function loadConfiguration() {
  try {
    const configSs = SpreadsheetApp.openByUrl(AGENCY_CONFIG_URL);

    const clients    = loadClientsFromSheet(configSs);
    const splitRules = loadSplitRulesFromSheet(configSs);
    const thresholds = loadThresholdsFromSheet(configSs);
    const locations  = loadLocationsFromSheet(configSs);

    for (const accountId in clients) {
      clients[accountId].splitRules     = splitRules[accountId] || {};
      clients[accountId].locationLookup = locations[accountId]  || {};
    }

    return {
      clients,
      thresholds,
      budgetStages: DEFAULT_BUDGET_STAGES,
      execution: { MAX_RUNTIME_MINUTES: 25, BATCH_SIZE: 10, LOG_LEVEL: 3 }
    };
  } catch (error) {
    utils.logError('Error loading configuration', error);
    return {
      clients:      {},
      thresholds:   { global: DEFAULT_THRESHOLDS },
      budgetStages: DEFAULT_BUDGET_STAGES,
      execution:    { MAX_RUNTIME_MINUTES: 25, BATCH_SIZE: 10, LOG_LEVEL: 3 }
    };
  }
}

// ─── Tab Loaders ─────────────────────────────────────────────────────────────

function loadClientsFromSheet(ss) {
  const sheet = ss.getSheetByName('Clients');
  if (!sheet) throw new Error('"Clients" tab not found in config workbook');

  const data    = sheet.getDataRange().getValues();
  const headers = data[0];
  const idx     = buildColumnIndex(headers, CLIENTS_COLUMNS);
  const clients = {};

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[idx.accountId] || row[idx.isActive] === false || row[idx.isActive] === 'FALSE') continue;

    const accountId = normalizeAccountId(row[idx.accountId]);
    clients[accountId] = {
      accountId,
      name:                row[idx.clientName]          || '',
      agencySheetName:     row[idx.agencySheetName]     || '',
      budgetInputSheet:    row[idx.budgetInputSheet]     || '',
      clientWorkbookUrl:   row[idx.clientWorkbookUrl]   || '',
      accountManagerEmail: row[idx.accountManagerEmail] || '',
      budgetCycle:         row[idx.budgetCycle]         || BUDGET_CYCLES.MONTHLY,
      annualStartMonth:    Number(row[idx.annualStartMonth]) || 1,
      highBudgetThreshold: Number(row[idx.highBudgetThreshold]) || 300,
      brandPrefixRegex:    row[idx.brandPrefixRegex]    || null,
      campaignTypeRegex:   row[idx.campaignTypeRegex]   || null,
      splitRules:          {},
      locationLookup:      {}
    };
  }

  utils.log(`Loaded ${Object.keys(clients).length} active clients`, utils.LOG_LEVELS.INFO);
  return clients;
}

function loadSplitRulesFromSheet(ss) {
  const sheet = ss.getSheetByName('SplitRules');
  if (!sheet) { utils.log('No SplitRules tab found', utils.LOG_LEVELS.WARNING); return {}; }

  const data    = sheet.getDataRange().getValues();
  const headers = data[0];
  const idx     = buildColumnIndex(headers, SPLIT_RULES_COLUMNS);
  const rules   = {};

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[idx.accountId] || !row[idx.campaignType]) continue;

    const accountId    = normalizeAccountId(row[idx.accountId]);
    const campaignType = row[idx.campaignType].toString().trim();
    if (!rules[accountId]) rules[accountId] = {};

    rules[accountId][campaignType] = {
      campaignType,
      authPattern:     row[idx.authPattern]              || AUTHORIZATION_PATTERNS.PERCENTAGE,
      splitPercentage: parseFloat(row[idx.splitPercentage]) || null,
      fixedDefault:    parseFloat(row[idx.fixedDefault])    || null,
      notes:           row[idx.notes]                    || ''
    };
  }
  return rules;
}

function loadThresholdsFromSheet(ss) {
  const sheet = ss.getSheetByName('Thresholds');
  if (!sheet) return { global: DEFAULT_THRESHOLDS };

  const data    = sheet.getDataRange().getValues();
  const headers = data[0];
  const idx     = buildColumnIndex(headers, THRESHOLDS_COLUMNS);
  const result  = { global: Object.assign({}, DEFAULT_THRESHOLDS) };

  for (let i = 1; i < data.length; i++) {
    const row       = data[i];
    const accountId = row[idx.accountId] ? normalizeAccountId(row[idx.accountId]) : 'global';
    result[accountId] = {
      warningVariance:  parseFloat(row[idx.warningVariance])  || DEFAULT_THRESHOLDS.WARNING_VARIANCE,
      criticalVariance: parseFloat(row[idx.criticalVariance]) || DEFAULT_THRESHOLDS.CRITICAL_VARIANCE,
      minDailyBudget:   parseFloat(row[idx.minDailyBudget])   || DEFAULT_THRESHOLDS.MIN_DAILY_BUDGET,
      velocityWindow:   parseInt(row[idx.velocityWindow])     || DEFAULT_THRESHOLDS.VELOCITY_WINDOW
    };
  }
  return result;
}

/**
 * Load Locations tab. Lookup keyed by fullLocation (lowercase) per client.
 *
 * Shape: { accountId: { 'wa - puyallup meridian': { identifierLabel, identifierValue, state, facilityName, fullLocation } } }
 */
function loadLocationsFromSheet(ss) {
  const sheet = ss.getSheetByName('Locations');
  if (!sheet) { utils.log('No Locations tab found', utils.LOG_LEVELS.WARNING); return {}; }

  const data      = sheet.getDataRange().getValues();
  const headers   = data[0];
  const idx       = buildColumnIndex(headers, LOCATIONS_COLUMNS);
  const locations = {};

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[idx.accountId] || !row[idx.fullLocation]) continue;

    const accountId   = normalizeAccountId(row[idx.accountId]);
    const fullLocation = row[idx.fullLocation].toString().trim();

    if (!locations[accountId]) locations[accountId] = {};

    locations[accountId][fullLocation.toLowerCase()] = {
      identifierLabel: row[idx.identifierLabel] || '',
      identifierValue: row[idx.identifierValue] || '',
      state:           row[idx.state]           || '',
      facilityName:    row[idx.facilityName]    || '',
      fullLocation
    };
  }

  const total = Object.values(locations).reduce((sum, c) => sum + Object.keys(c).length, 0);
  utils.log(`Loaded ${total} locations across all clients`, utils.LOG_LEVELS.INFO);
  return locations;
}

// ─── Client Config Accessor ───────────────────────────────────────────────────

function getClientConfig(accountId, systemConfig) {
  const normalized = normalizeAccountId(accountId);
  const client     = systemConfig.clients[normalized];
  if (!client) {
    utils.log(`No client config found for account: ${accountId}`, utils.LOG_LEVELS.WARNING);
    return null;
  }
  client.thresholds   = systemConfig.thresholds[normalized] || systemConfig.thresholds['global'] || DEFAULT_THRESHOLDS;
  client.budgetStages = systemConfig.budgetStages;
  return client;
}

function validateClientConfig(clientConfig) {
  const errors = [];
  if (!clientConfig.name)              errors.push('Missing client name');
  if (!clientConfig.accountId)         errors.push('Missing account ID');
  if (!clientConfig.clientWorkbookUrl) errors.push('Missing client workbook URL');
  if (!clientConfig.agencySheetName)   errors.push('Missing agency sheet name');
  if (!clientConfig.budgetInputSheet)  errors.push('Missing budget input sheet name');
  if (Object.keys(clientConfig.splitRules).length === 0)
    errors.push('No split rules defined');
  if (Object.keys(clientConfig.locationLookup).length === 0)
    errors.push('No locations defined — identifier matching will be skipped');
  return { success: errors.length === 0, errors };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeAccountId(id) {
  const digits = id.toString().replace(/\D/g, '');
  if (digits.length === 10) return `${digits.slice(0,3)}-${digits.slice(3,6)}-${digits.slice(6)}`;
  return id.toString().trim();
}

function buildColumnIndex(headers, columnMap) {
  const idx = {};
  for (const [key, headerName] of Object.entries(columnMap)) {
    idx[key] = headers.indexOf(headerName);
    if (idx[key] === -1) utils.log(`Column "${headerName}" not found in sheet`, utils.LOG_LEVELS.WARNING);
  }
  return idx;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

const configManager = {
  loadConfiguration,
  getClientConfig,
  validateClientConfig,
  normalizeAccountId,
  buildColumnIndex,
  BUDGET_CYCLES,
  AUTHORIZATION_PATTERNS,
  DEFAULT_THRESHOLDS,
  DEFAULT_BUDGET_STAGES,
  AGENCY_PREFIX,
  AGENCY_CONFIG_URL,
  AGENCY_BUDGET_URL,
  CLIENTS_COLUMNS,
  SPLIT_RULES_COLUMNS,
  THRESHOLDS_COLUMNS,
  LOCATIONS_COLUMNS
};
