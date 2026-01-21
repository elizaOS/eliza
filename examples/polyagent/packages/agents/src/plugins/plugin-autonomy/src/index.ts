import type { Plugin } from "@elizaos/core";
import { sendToAdminAction } from "./action";
import { adminChatProvider } from "./provider";
import { autonomyRoutes } from "./routes";
import { AutonomyService } from "./service";
import { autonomyStatusProvider } from "./status-provider";

/**
 * Clean autonomy plugin with settings-based control:
 * 1. Service: Autonomous loop controlled via AUTONOMY_ENABLED setting
 * 2. Admin Chat Provider: Admin history (autonomous context only)
 * 3. Status Provider: Shows autonomy status (regular chat only)
 * 4. Action: Send message to admin (autonomous context only)
 * 5. Routes: API for enable/disable/status
 */
export const autonomyPlugin: Plugin = {
  name: "autonomy",
  description: "Clean autonomous loop plugin with settings-based control",

  services: [AutonomyService],
  providers: [adminChatProvider, autonomyStatusProvider],
  actions: [sendToAdminAction],
  routes: autonomyRoutes,
};

export { sendToAdminAction } from "./action";
export { adminChatProvider } from "./provider";
export { autonomyRoutes } from "./routes";
// Export components
export { AutonomyService } from "./service";
export { autonomyStatusProvider } from "./status-provider";

export default autonomyPlugin;
