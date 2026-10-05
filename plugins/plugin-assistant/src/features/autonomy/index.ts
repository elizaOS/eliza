/**
 * Autonomy module for elizaOS
 *
 * Provides autonomous operation capabilities for agents.
 */

// Action
export {
  disableAutonomousModeAction,
  enableAutonomousModeAction,
  escalateAction,
} from "./action";
// Providers
export { adminChatProvider, autonomyStatusProvider } from "./providers.ts";
// Routes
export { autonomyRoutes } from "./routes.ts";
// Service
export {
  AUTONOMY_SERVICE_TYPE,
  AUTONOMY_TASK_NAME,
  AUTONOMY_TASK_TAGS,
  AutonomyService,
} from "./service.ts";
// Types
export type { AutonomyConfig, AutonomyStatus } from "./types.ts";
