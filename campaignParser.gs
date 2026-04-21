/**
 * GLI Budget Pacing System - Campaign Name Parser Module
 * Version: 2.1.0
 *
 * Parses GLI campaign names into segments:
 *   "GLI - [STATE - ] [Facility Name] ([CampaignType])"
 *
 * State segment is optional and client-specific.
 * Location identifier (Site Code, etc.) resolved via lookup table loaded at start.
 *
 * Parse result shape:
 * {
 *   raw:              string,   // original campaign name
 *   agencyPrefix:     string,   // "GLI - " if found
 *   state:            string,   // "WA" | "" if client has no state segment
 *   facilityName:     string,   // "Puyallup Meridian"
 *   fullLocation:     string,   // "WA - Puyallup Meridian" | facilityName if no state
 *   location:         string,   // alias for fullLocation (used by downstream budget matching)
 *   campaignType:     string,   // normalized: "Search" | "Brand" | "PMax" | etc.
 *   rawType:          string,   // as it appeared in parens
 *   identifierLabel:  string,   // "Site Code" | "" if no lookup match
 *   identifierValue:  string,   // "TSPU2" | ""
 *   isValid:          boolean,
 *   parseWarnings:    string[]
 * }
 */

// ─── Default Patterns ─────────────────────────────────────────────────────────

const DEFAULT_CAMPAIGN_TYPE_REGEX = /\s*\(([^)]+)\)\s*$/;

// Matches "WA - " / "OR - " / "CA - " style state prefixes
const STATE_SEGMENT_REGEX = /^([A-Z]{2})\s+-\s+/;

const CAMPAIGN_TYPE_NORMALIZATIONS = {
  'pmax':             'PMax',
  'performance max':  'PMax',
  'performance_max':  'PMax',
  'search':           'Search',
  'brand':            'Brand',
  'branded':          'Brand',
  'conquest':         'Conquest',
  'conquest generic': 'Conquest',
  'generic':          'Generic',
  'display':          'Display',
  'remarketing':      'Remarketing',
  'youtube':          'YouTube'
};

// ─── Primary Parse Function ───────────────────────────────────────────────────

/**
 * Parse a single campaign name.
 * @param {string} campaignName
 * @param {Object} clientConfig  — must include locationLookup, brandPrefixRegex, campaignTypeRegex
 * @returns {Object} parse result (see module header for shape)
 */
function parseCampaignName(campaignName, clientConfig) {
  const result = {
    raw:             campaignName || '',
    agencyPrefix:    '',
    state:           '',
    facilityName:    '',
    fullLocation:    '',
    location:        '',       // alias, set at end
    campaignType:    'Unknown',
    rawType:         '',
    identifierLabel: '',
    identifierValue: '',
    isValid:         false,
    parseWarnings:   []
  };

  if (!campaignName) {
    result.parseWarnings.push('Empty campaign name');
    return result;
  }

  let working = campaignName.trim();

  // ── Step 1: Strip agency prefix ──────────────────────────────────────────────
  const agencyPrefix = configManager.AGENCY_PREFIX; // "GLI - "
  if (working.startsWith(agencyPrefix)) {
    result.agencyPrefix = agencyPrefix;
    working             = working.slice(agencyPrefix.length).trim();
    result.isValid      = true;
  } else {
    result.parseWarnings.push(`Missing agency prefix "${agencyPrefix}"`);
  }

  // ── Step 2: Extract campaign type suffix ─────────────────────────────────────
  const typeRegex = buildSafeRegex(
    clientConfig && clientConfig.campaignTypeRegex,
    DEFAULT_CAMPAIGN_TYPE_REGEX,
    'campaign type'
  );
  const typeMatch = working.match(typeRegex);
  if (typeMatch) {
    result.rawType      = typeMatch[1].trim();
    result.campaignType = normalizeCampaignType(result.rawType);
    working             = working.slice(0, typeMatch.index).trim();
  } else {
    result.parseWarnings.push('No parenthesized campaign type found');
  }

  // ── Step 3: Detect optional state segment "WA - " ────────────────────────────
  const stateMatch = working.match(STATE_SEGMENT_REGEX);
  if (stateMatch) {
    result.state = stateMatch[1];                       // "WA"
    working      = working.slice(stateMatch[0].length).trim();
  }
  // If no state match, working is treated as facility name directly
  // (handles clients without state segment)

  // ── Step 4: Strip optional brand prefix to isolate facility name ─────────────
  // Only applies to clients that set brandPrefixRegex and don't use state segments
  if (!result.state && clientConfig && clientConfig.brandPrefixRegex) {
    const brandRegex = buildSafeRegex(clientConfig.brandPrefixRegex, null, 'brand prefix');
    if (brandRegex) {
      const brandMatch = working.match(brandRegex);
      if (brandMatch) {
        working = working.slice(brandMatch[0].length).trim();
      } else {
        result.parseWarnings.push(`Brand prefix regex did not match: "${working}"`);
      }
    }
  }

  // ── Step 5: Remaining string is the facility name ────────────────────────────
  result.facilityName = working.trim();
  result.fullLocation = result.state
    ? `${result.state} - ${result.facilityName}`
    : result.facilityName;
  result.location = result.fullLocation; // downstream uses .location for budget matching

  if (!result.facilityName) {
    result.parseWarnings.push('No facility name could be extracted');
  }

  // ── Step 6: Resolve location identifier from lookup table ────────────────────
  if (clientConfig && clientConfig.locationLookup) {
    const lookupKey = result.fullLocation.toLowerCase();
    const entry     = clientConfig.locationLookup[lookupKey];
    if (entry) {
      result.identifierLabel = entry.identifierLabel;
      result.identifierValue = entry.identifierValue;
    } else if (result.fullLocation) {
      result.parseWarnings.push(
        `No location lookup match for "${result.fullLocation}" — identifier will be empty`
      );
    }
  }

  return result;
}

// ─── Batch Parser ─────────────────────────────────────────────────────────────

/**
 * Parse an array of campaign objects in place.
 * Attaches parsedName, location, campaignType, identifierValue to each.
 * @param {Array}  campaigns
 * @param {Object} clientConfig
 * @returns {Array} mutated campaigns
 */
function parseCampaignNames(campaigns, clientConfig) {
  for (const campaign of campaigns) {
    campaign.parsedName      = parseCampaignName(campaign.name, clientConfig);
    campaign.location        = campaign.parsedName.fullLocation;
    campaign.facilityName    = campaign.parsedName.facilityName;
    campaign.state           = campaign.parsedName.state;
    campaign.campaignType    = campaign.parsedName.campaignType;
    campaign.identifierLabel = campaign.parsedName.identifierLabel;
    campaign.identifierValue = campaign.parsedName.identifierValue;

    if (campaign.parsedName.parseWarnings.length > 0) {
      utils.log(
        `Parse warnings for "${campaign.name}": ${campaign.parsedName.parseWarnings.join('; ')}`,
        utils.LOG_LEVELS.DEBUG
      );
    }
  }
  return campaigns;
}

// ─── Grouping Helpers ─────────────────────────────────────────────────────────

function groupCampaignsByLocation(campaigns) {
  return campaigns.reduce((acc, c) => {
    const loc = c.location || 'Unknown Location';
    if (!acc[loc]) acc[loc] = [];
    acc[loc].push(c);
    return acc;
  }, {});
}

function groupCampaignsByLocationAndType(campaigns) {
  return campaigns.reduce((acc, c) => {
    acc[buildLocationTypeKey(c.location, c.campaignType)] = c;
    return acc;
  }, {});
}

/**
 * Composite key for budget row matching.
 * Uses identifierValue (Site Code) when available, falls back to fullLocation.
 * @param {string} locationOrId  — identifierValue preferred, fullLocation as fallback
 * @param {string} campaignType
 * @returns {string}
 */
function buildLocationTypeKey(locationOrId, campaignType) {
  return `${(locationOrId || 'Unknown').trim()}||${(campaignType || 'Unknown').trim()}`;
}

function isParsedCampaignMatchable(parsedName) {
  return (
    parsedName.isValid &&
    parsedName.facilityName  !== '' &&
    parsedName.campaignType  !== 'Unknown'
  );
}

// ─── Diagnostic ───────────────────────────────────────────────────────────────

/**
 * Test helper — run from Apps Script editor to verify parsing.
 * Not called in production.
 */
function testParser() {
  const config = configManager.loadConfiguration();
  const client = Object.values(config.clients)[0];
  if (!client) { Logger.log('No clients loaded'); return; }

  Logger.log(`Testing parser for client: ${client.name}`);
  Logger.log(`Location lookup entries: ${Object.keys(client.locationLookup).length}`);

  const testNames = [
    `GLI - WA - Puyallup Meridian (Search)`,
    `GLI - WA - Puyallup Meridian (Brand)`,
    `GLI - OR - Portland (PMax)`,
    `GLI - CA - BA Self Storage (Search)`,
    `Bad Campaign Name Without Prefix`,
    `GLI - WA - Unknown Facility (Search)` // should warn on lookup
  ];

  testNames.forEach(name => {
    const result = parseCampaignName(name, client);
    Logger.log([
      `\nInput:    "${name}"`,
      `State:    "${result.state}"`,
      `Facility: "${result.facilityName}"`,
      `FullLoc:  "${result.fullLocation}"`,
      `Type:     "${result.campaignType}"`,
      `ID Label: "${result.identifierLabel}"`,
      `ID Value: "${result.identifierValue}"`,
      `Valid:    ${result.isValid}`,
      `Warnings: ${result.parseWarnings.join(' | ') || 'none'}`
    ].join('\n'));
  });
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function normalizeCampaignType(rawType) {
  if (!rawType) return 'Unknown';
  return CAMPAIGN_TYPE_NORMALIZATIONS[rawType.toLowerCase().trim()] || rawType.trim();
}

function buildSafeRegex(source, fallback, contextName) {
  if (!source) return fallback;
  try {
    return new RegExp(source, 'i');
  } catch (e) {
    utils.log(`Invalid regex for ${contextName}: "${source}" — using default`, utils.LOG_LEVELS.WARNING);
    return fallback;
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

const campaignParser = {
  parseCampaignName,
  parseCampaignNames,
  groupCampaignsByLocation,
  groupCampaignsByLocationAndType,
  buildLocationTypeKey,
  isParsedCampaignMatchable,
  normalizeCampaignType,
  testParser,
  DEFAULT_CAMPAIGN_TYPE_REGEX,
  CAMPAIGN_TYPE_NORMALIZATIONS
};
