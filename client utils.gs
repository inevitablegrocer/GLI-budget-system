/**
 * MCC Budget Pacing System - client Utilities Module
 * Version: 1.0.0
 * Last Updated: 2025-02-27
 * 
 * This module provides common utility functions for the Budget Pacing System.
 * It includes logging, error handling, date formatting, and other helper functions.
 */

// Define log levels
const LOG_LEVELS = {
  ERROR: 1,
  WARNING: 2,
  INFO: 3,
  DEBUG: 4
};

// Current log level (can be overridden by configuration)
let currentLogLevel = LOG_LEVELS.INFO;

/**
 * Set the current logging level
 * @param {number} level - Log level to set
 */
function setLogLevel(level) {
  if (level >= LOG_LEVELS.ERROR && level <= LOG_LEVELS.DEBUG) {
    currentLogLevel = level;
  } else {
    Logger.log(`Invalid log level: ${level}. Using default INFO level.`);
    currentLogLevel = LOG_LEVELS.INFO;
  }
}

/**
 * Log a message with a specific log level
 * @param {string} message - Message to log
 * @param {number} level - Log level
 */
function log(message, level = LOG_LEVELS.INFO) {
  // Only log if the level is less than or equal to the current log level
  if (level <= currentLogLevel) {
    const levelName = Object.keys(LOG_LEVELS).find(key => LOG_LEVELS[key] === level) || 'UNKNOWN';
    Logger.log(`[${levelName}] ${message}`);
  }
}

/**
 * Log an error with stack trace if available
 * @param {string} message - Error message
 * @param {Error} error - Error object
 */
function logError(message, error) {
  if (error && error.stack) {
    log(`${message}: ${error.message}\n${error.stack}`, LOG_LEVELS.ERROR);
  } else {
    log(`${message}: ${error}`, LOG_LEVELS.ERROR);
  }
}

/**
 * Format date as YYYY-MM-DD
 * @param {Date} date - Date to format
 * @param {string} timeZone - Time zone
 * @returns {string} Formatted date string
 */
function formatDate(date, timeZone) {
  return Utilities.formatDate(date, timeZone, 'yyyy-MM-dd');
}

/**
 * Initialize metrics tracking object
 * @returns {Object} Metrics object with default values
 */
function initializeMetrics() {
  return {
    totalAccounts: 0,
    processedAccounts: 0,
    skippedAccounts: 0,
    failedAccounts: 0,
    totalProcessingTime: 0,
    errorDetails: [],
    fatalErrors: [],
    timeoutTerminated: false
  };
}

/**
 * Log performance summary
 * @param {Object} metrics - Performance metrics
 * @param {Date} startTime - Script start time
 */
function logPerformanceSummary(metrics, startTime) {
  const runtime = (new Date() - startTime) / 1000;
  
  log('==== Performance Summary ====', LOG_LEVELS.INFO);
  log(`Total accounts: ${metrics.totalAccounts}`, LOG_LEVELS.INFO);
  log(`Processed: ${metrics.processedAccounts}`, LOG_LEVELS.INFO);
  log(`Skipped: ${metrics.skippedAccounts}`, LOG_LEVELS.INFO);
  log(`Failed: ${metrics.failedAccounts}`, LOG_LEVELS.INFO);
  log(`Runtime: ${runtime.toFixed(2)} seconds`, LOG_LEVELS.INFO);
  
  if (metrics.processedAccounts > 0) {
    const avgTime = metrics.totalProcessingTime / metrics.processedAccounts;
    log(`Average processing time: ${avgTime.toFixed(2)} seconds per account`, LOG_LEVELS.INFO);
  }
  
  if (metrics.errorDetails.length > 0) {
    log('==== Error Details ====', LOG_LEVELS.INFO);
    metrics.errorDetails.forEach((error, i) => {
      log(`${i+1}. Account: ${error.accountName} (${error.accountId})`, LOG_LEVELS.ERROR);
      log(`   Error: ${error.error}`, LOG_LEVELS.ERROR);
    });
  }
  
  if (metrics.fatalErrors.length > 0) {
    log('==== Fatal Errors ====', LOG_LEVELS.ERROR);
    metrics.fatalErrors.forEach((error, i) => {
      log(`${i+1}. ${error}`, LOG_LEVELS.ERROR);
    });
  }
  
  if (metrics.timeoutTerminated) {
    log('Script terminated early due to timeout limit', LOG_LEVELS.WARNING);
  }
}

/**
 * Maps column names to indices
 * @param {Array} headers - Sheet headers array
 * @param {Object} columnMap - Column name mapping object
 * @returns {Object} Object mapping column keys to indices
 */
function mapColumnIndices(headers, columnMap) {
  const indices = {};
  
  // Map each defined column to its index
  Object.entries(columnMap).forEach(([key, columnName]) => {
    const index = headers.indexOf(columnName);
    indices[key] = index;
  });
  
  return indices;
}

/**
 * Generate a unique ID
 * @returns {string} Unique ID
 */
function generateUniqueId() {
  return 'id_' + Math.random().toString(36).substr(2, 9) + '_' + new Date().getTime();
}

/**
 * Check if a value is a valid number
 * @param {*} value - Value to check
 * @returns {boolean} True if the value is a valid number
 */
function isValidNumber(value) {
  // Check if value is a number and not NaN or Infinity
  return typeof value === 'number' && !isNaN(value) && isFinite(value);
}

/**
 * Calculate percentage change between two values
 * @param {number} oldValue - Old value
 * @param {number} newValue - New value
 * @returns {number} Percentage change
 */
function calculatePercentageChange(oldValue, newValue) {
  if (oldValue === 0) {
    return newValue === 0 ? 0 : 1; // 100% increase if starting from 0
  }
  
  return (newValue - oldValue) / Math.abs(oldValue);
}

/**
 * Safely parse float from potentially problematic values
 * @param {*} value - Value to parse
 * @returns {number} Parsed float or 0 if invalid
 */
function safeParseFloat(value) {
  if (typeof value === 'number') return value;
  
  if (typeof value === 'string') {
    // Remove currency symbols and commas
    const cleanValue = value.replace(/[$,]/g, '');
    const parsed = parseFloat(cleanValue);
    return isNaN(parsed) ? 0 : parsed;
  }
  
  return 0;
}

/**
 * Check if a value is significantly different from another
 * @param {number} value1 - First value
 * @param {number} value2 - Second value
 * @param {number} threshold - Threshold for significance (0.2 = 20%)
 * @returns {boolean} True if the difference is significant
 */
function isSignificantDifference(value1, value2, threshold = 0.2) {
  if (!isValidNumber(value1) || !isValidNumber(value2)) return false;
  
  if (value1 === 0) {
    return Math.abs(value2) >= threshold;
  }
  
  return Math.abs((value2 - value1) / value1) >= threshold;
}

/**
 * Deep clone an object
 * @param {Object} obj - Object to clone
 * @returns {Object} Cloned object
 */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Format currency value
 * @param {number} value - Value to format
 * @param {number} [decimals=2] - Number of decimal places
 * @returns {string} Formatted currency string
 */
function formatCurrency(value, decimals = 2) {
  if (!isValidNumber(value)) return '$0.00';
  
  return '$' + value.toFixed(decimals).replace(/\d(?=(\d{3})+\.)/g, '$&,');
}

/**
 * Format percentage value
 * @param {number} value - Value to format (0.1 = 10%)
 * @param {number} [decimals=1] - Number of decimal places
 * @returns {string} Formatted percentage string
 */
function formatPercentage(value, decimals = 1) {
  if (!isValidNumber(value)) return '0.0%';
  
  return (value * 100).toFixed(decimals) + '%';
}

// Export functions and constants
const utils = {
  LOG_LEVELS,
  setLogLevel,
  log,
  logError,
  formatDate,
  initializeMetrics,
  logPerformanceSummary,
  mapColumnIndices,
  generateUniqueId,
  isValidNumber,
  calculatePercentageChange,
  safeParseFloat,
  isSignificantDifference,
  deepClone,
  formatCurrency,
  formatPercentage
};
