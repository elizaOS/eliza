/**
 * Autonomy module for elizaOS
 *
 * Provides autonomous operation capabilities for agents.
 */

// Action
export { sendToAdminAction } from "./action";
// Providers
export { adminChatProvider, autonomyStatusProvider } from "./providers";
// Routes
export { autonomyRoutes } from "./routes";
// Service
export {
	AUTONOMY_SERVICE_TYPE,
	AUTONOMY_TASK_NAME,
	AUTONOMY_TASK_TAGS,
	AutonomyService,
} from "./service";
// Types
export type { AutonomyConfig, AutonomyStatus } from "./types";
