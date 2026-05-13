// `health-bridge` lives in `@elizaos/plugin-health`; re-export so existing
// `from "./lifeops"` callers keep resolving.
export {
  detectHealthBackend,
  getDailySummary,
  getDataPoints,
  getRecentSummaries,
  type HealthBackend,
  type HealthBridgeConfig,
  HealthBridgeError,
  type HealthDailySummary,
  type HealthDataPoint,
} from "@elizaos/plugin-health";
export * from "./app-state.js";
export * from "./apple-reminders.js";
export * from "./bulk-review.js";
export * from "./calendly-client.js";
export * from "./context-graph.js";
export * from "./defaults.js";
export * from "./document-review.js";
export * from "./email-curation.js";
export * from "./enforcement-windows.js";
export * from "./engine.js";
export * from "./goal-grounding.js";
export * from "./goal-semantic-evaluator.js";
export * from "./google-plugin-delegates.js";
export * from "./intent-sync.js";
export * from "./owner-profile.js";
export * from "./password-manager-bridge.js";
export * from "./policy-memory.js";
export * from "./remote-desktop.js";
export * from "./repository.js";
export * from "./runtime.js";
export * from "./schema.js";
export * from "./screen-context.js";
export * from "./service.js";
export * from "./sql.js";
export * from "./time.js";
export * from "./twilio.js";
export * from "./voice-affect.js";
