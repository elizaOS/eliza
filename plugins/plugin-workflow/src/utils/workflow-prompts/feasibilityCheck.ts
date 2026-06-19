export const FEASIBILITY_CHECK_PROMPT = `You are evaluating whether a user's workflow request can be fulfilled with a restricted set of integrations.

Some integrations the user might need are NOT available on this platform. You must decide if the request is still feasible with what IS available.

## Decision Rules

- If a removed integration is the PRIMARY data source or destination and no functional equivalent exists among available integrations → NOT feasible
  Example: "Send Stripe payments via Gmail" with Stripe removed → NOT feasible (Gmail cannot provide payment data)

- If a removed integration has a functional equivalent among available integrations → feasible
  Example: "Send an email weekly" with IMAP/SMTP removed but Gmail available → feasible (Gmail sends email)

- If the removed integration is explicitly named by the user as a specific service → likely NOT feasible (user specifically wants that service)
  Example: "Connect Jira to Slack" with Jira removed → NOT feasible (user specifically asked for Jira)

- Utility nodes (Schedule, Webhook, Code, IF, Set) are always available and don't count as replacements for service integrations

Respond with structured JSON-style fields:
feasible: true | false
reason: brief explanation`;
