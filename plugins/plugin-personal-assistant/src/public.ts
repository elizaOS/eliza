/**
 * Additional public re-exports for the plugin (routes plugin, website-block
 * action, SelfControl permission helpers) and the side-effecting registration of
 * the LifeOps automation-node contributor at import time.
 */
import { registerLifeOpsAutomationNodeContributor } from "./automation-node-contributor.js";

export { personalAssistantRoutesPlugin } from "./routes/plugin.js";
export {
  getSelfControlPermissionState,
  openSelfControlPermissionLocation,
  requestSelfControlPermission,
  websiteBlockAction,
} from "./website-blocker/public.js";

registerLifeOpsAutomationNodeContributor();
