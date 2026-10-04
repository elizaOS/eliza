/** The application host composes its Android receiver before starting the portable agent. */

import { STATIC_ELIZA_PLUGINS } from "@elizaos/agent/runtime/plugin-types";
import { browserPlugin } from "@elizaos/plugin-browser";
import { workflowPlugin } from "@elizaos/plugin-workflow";
import { mobileRemoteTargetPlugin } from "./mobile-remote-target";

STATIC_ELIZA_PLUGINS["@elizaos/app/mobile-remote-target"] = {
  default: mobileRemoteTargetPlugin,
};
STATIC_ELIZA_PLUGINS["@elizaos/plugin-browser"] = { default: browserPlugin };
STATIC_ELIZA_PLUGINS["@elizaos/plugin-workflow"] = { default: workflowPlugin };
const { installMobileWorkflowProcessHost } = await import(
  "./runtime/install-mobile-workflow-process-host"
);
installMobileWorkflowProcessHost();
const { installMobileAuthHostBridge } = await import(
  "./runtime/install-mobile-auth-host-bridge"
);
installMobileAuthHostBridge();
await import("@elizaos/agent/bin");
