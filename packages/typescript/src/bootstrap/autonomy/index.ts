/**
 * Autonomy Module for elizaOS Bootstrap
 * 
 * Provides autonomous operation capabilities for agents.
 */

// Types
export type { AutonomyConfig, AutonomyStatus } from "./types";

// Service
export { AutonomyService, AUTONOMY_SERVICE_TYPE } from "./service";

// Action
export { sendToAdminAction } from "./action";

// Providers
export { adminChatProvider, autonomyStatusProvider } from "./providers";

// Routes
export { autonomyRoutes } from "./routes";


