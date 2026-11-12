/** The application host composes its Android receiver before starting the portable agent. */

import { STATIC_ELIZA_PLUGIN_LOADERS } from "@elizaos/agent/runtime/plugin-types";

// Load on first resolve, so a host that denies the plugin never evaluates it.
// The agent registers the browser and workflow loaders itself.
STATIC_ELIZA_PLUGIN_LOADERS["@elizaos/app/mobile-remote-target"] =
  async () => ({
    default: (await import("./mobile-remote-target")).mobileRemoteTargetPlugin,
  });
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
const { prepareNativeRuntimeForBoot } = await import(
  "./runtime/native-runtime-boot"
);
// bin starts its CLI asynchronously. The private server belongs to the resident
// process, rather than the completion of this module's import. An admission
// failure leaves Google unavailable but must not stop the on-device agent.
await prepareNativeRuntimeForBoot();
await import("@elizaos/agent/bin");
