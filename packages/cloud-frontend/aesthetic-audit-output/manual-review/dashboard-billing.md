# Manual review — dashboard-billing

Route inferred from slug. Screenshots: `../desktop/dashboard-billing.png`, `../desktop/dashboard-billing--hover.png`, `../mobile/dashboard-billing.png`

## Verdict

`needs-work`

Loop-4 JWT injection fixed the Unauthorized error boundary; the page now mounts and shows the layout chrome. The four billing summary tiles and three list rows still render as skeleton because the audit's broad /\b\/billing/ mock doesn't satisfy the specific queries this page issues (likely `useUpcomingInvoice`, `usePaymentMethods`). Action for loop 5: tighten the mock to return `{ amount: 0, currency: 'USD', dueAt: null }` for upcoming invoices and `[]` for payment methods. No color violations visible in the chrome.
