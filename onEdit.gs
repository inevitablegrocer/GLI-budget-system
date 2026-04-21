/**
 * GLI Budget Pacing System - Master onEdit Handler
 * Version: 2.0.0
 *
 * Routes edit events to the appropriate handler based on sheet type.
 */

function onEdit(event) {
  if (!event) {
    throw new Error('Do not run directly. Runs automatically on sheet edit.');
  }

  // 1. Legacy "25/26 Budgets" timestamp handler (keep for backward compatibility)
  try {
    processSheets(event, [
      {
        sheetsToWatch: /^.*2[56] Budgets$/i,
        columnConfigs: [
          {
            labelToWatch: 'Recommended Budget Approved',
            labelToStamp: 'Approval Timestamp',
            valueToWatch: true
          },
          {
            labelToWatch: 'No Ads This Month',
            labelToStamp: 'Disapproval Timestamp',
            valueToWatch: true
          },
          {
            labelToWatch: 'Pre-Approved Client Budgets',
            labelToStamp: 'Pre-Approval Timestamp'
          },
          {
            labelToWatch:    'Budget Total',
            labelToStamp:    'Budget Total Timestamp',
            eraseTimestamp:  true
          }
        ]
      }
    ]);
  } catch (e) {
    console.error('processSheets error:', e);
  }

  // 2. New Budget Input tab handler
  try {
    handleBudgetInputEdit(event);
  } catch (e) {
    console.error('budgetInput.handleBudgetInputEdit error:', e);
  }

  // 3. AdPulse check (budget change flag)
  try {
    updateAdPulseCheck(event);
  } catch (e) {
    console.error('updateAdPulseCheck error:', e);
  }

  // 4. AdPulse budget verification
  try {
    handleAdPulseEdit(event);
  } catch (e) {
    console.error('handleAdPulseEdit error:', e);
  }
}
