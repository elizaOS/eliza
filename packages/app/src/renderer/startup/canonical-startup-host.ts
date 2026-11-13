import { createBrowserStartupHost } from "@elizaos/ui/startup/browser-host";
import {
  createStartupCoordinator,
  createStartupHydration,
  createStartupPoll,
  createStartupRestore,
  createStartupRuntime,
} from "@elizaos/ui/startup/coordinator";
import {
  getAndroidLocalAgentBootStateForUrl,
  requestAndroidLocalAgentStartForUrl,
} from "../transports/android-native-agent-transport";
import {
  appendIosBootTrace,
  isIosInProcessLocalAgentBase,
  isIosNativeAgentBootInProgress,
  isTerminalIosNativeAgentBootErrorMessage,
} from "../transports/ios-local-agent-transport";

/** Existing canonical host ports; the browser service wiring is common. */
export const canonicalStartupPorts = createBrowserStartupHost({
  native: {
    getAndroidLocalAgentBootStateForUrl,
    requestAndroidLocalAgentStartForUrl,
    appendIosBootTrace,
    isIosInProcessLocalAgentBase,
    isIosNativeAgentBootInProgress,
    isTerminalIosNativeAgentBootErrorMessage,
  },
  executeRuntimeManagementCommand: async (request) =>
    (await import("../runtime-management")).executeRuntimeManagementCommand(
      request,
    ),
});
export const canonicalStartup = createStartupCoordinator(canonicalStartupPorts);
export const canonicalStartupRestore = createStartupRestore(
  canonicalStartupPorts,
);
export const canonicalStartupPoll = createStartupPoll(canonicalStartupPorts);
export const canonicalStartupRuntime = createStartupRuntime(
  canonicalStartupPorts,
);
export const canonicalStartupHydration = createStartupHydration(
  canonicalStartupPorts,
);
