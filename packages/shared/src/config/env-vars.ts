// CYCLE BREAK: previously re-exported `collectConfigEnvVars`,
// `collectConnectorEnvVars`, `CONNECTOR_ENV_MAP` from `@elizaos/agent`
// with a thin compat wrapper. That created an `agent → shared → agent`
// runtime cycle which broke node ESM resolution at the bench server
// boot ("conflicting star exports for name 'collectConfigEnvVars'").
//
// No consumer actually imported these symbols *via* `@elizaos/shared`
// (verified by repo-wide grep — every consumer imports from its local
// `config/env-vars.js` or directly from `@elizaos/agent`). The compat
// wrapper added a small TELEGRAM_ACCOUNT_ENV_MAP fallback and a
// startup-key blocklist; the upstream agent module already covers the
// blocklist, and the telegram fallback is tracked there too. Drop the
// shared-side wrapper entirely to break the cycle.
//
// If a future caller wants the behavior, they should import from
// `@elizaos/agent` directly (correct dependency direction).
export {};
