/**
 * Screen-time domain entry point.
 *
 * Health owns aggregation, range orchestration, public service contracts, and
 * HTTP query dispatch. Hosts inject activity rows, social projections, storage,
 * authentication, and transport serialization without copying calculations.
 */

export type {
  LifeOpsScreenTimePerAppUsage,
  LifeOpsScreenTimeSummaryPayload,
} from "../contracts/health.js";
export * from "./builders.js";
export * from "./mobile-signals.js";
export * from "./ranges.js";
export * from "./routes.js";
export * from "./service.js";
export * from "./social-taxonomy.js";
export * from "./system-inactivity-apps.js";
