export { getBrowserBridgeCompanionPackageStatus } from "@elizaos/plugin-browser-bridge";

import { registerLifeOpsAutomationNodeContributor } from "./automation-node-contributor.js";

export { lifeopsPlugin } from "./routes/plugin.js";
export {
  getSelfControlPermissionState,
  openSelfControlPermissionLocation,
  requestSelfControlPermission,
  websiteBlockAction,
} from "./website-blocker/public.js";

registerLifeOpsAutomationNodeContributor();
