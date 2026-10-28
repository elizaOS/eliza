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
// A host that selects a native runtime profile gets its process policy (for
// example, powered-on scheduling) before anything reads it, signed in or not.
const { applyNativeRuntimeProfileEnvironment } = await import(
  "./runtime/native-runtime-profile"
);
applyNativeRuntimeProfileEnvironment(process.env);
// Android's bridge command boots the runtime directly; it does not use dev-server.
// Admit the private Google host and its provider routing before that runtime starts.
const { startNativeManagedGoogleHostForBoot } = await import(
  "./runtime/native-managed-google-host"
);
// bin starts its CLI asynchronously. The private server belongs to the resident
// process, rather than the completion of this module's import. An admission
// failure leaves Google unavailable but must not stop the on-device agent.
await startNativeManagedGoogleHostForBoot();
await import("@elizaos/agent/bin");
