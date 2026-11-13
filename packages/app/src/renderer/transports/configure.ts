import {
  configureHostAgentCapabilities,
  configureHostTransport,
} from "@elizaos/ui/api/host-transport";
import { getAuthStatusSnapshot } from "@elizaos/ui/app/session";
import { isAndroidLocalAgentUrl } from "@elizaos/ui/first-run/local-agent-token";
import { configureRuntimeManagement } from "@elizaos/ui/platform/runtime-management";
import {
  androidNativeAgentLifecycleForUrl,
  androidNativeAgentTransportForUrl,
} from "./android-native-agent-transport";
import { nativeClockTransportForUrl } from "./clock-native-host";
import {
  iosInProcessAgentTransportForUrl,
  isIosInProcessLocalAgentBase,
  isTerminalIosNativeAgentBootErrorMessage,
} from "./ios-local-agent-transport";
import { nativeCloudHttpTransportForUrl } from "./native-cloud-http-transport";
import { remoteRelayTransportForUrl } from "./remote-relay-transport";
import { sshRuntimeTransportForUrl } from "./ssh-runtime-transport";

// Keep local, selected remote runtime, and native Cloud precedence. CSRF
// requests deliberately do not use relay/SSH selection.
configureHostTransport(async (url, purpose, init) => {
  const native =
    (await androidNativeAgentTransportForUrl(url)) ??
    (await iosInProcessAgentTransportForUrl(url));
  if (native) return native;
  if (purpose === "agent") {
    const remote =
      remoteRelayTransportForUrl(url) ?? sshRuntimeTransportForUrl(url);
    if (remote) return remote;
  }
  return (
    (await nativeClockTransportForUrl(url, init)) ??
    nativeCloudHttpTransportForUrl(url)
  );
});

configureHostAgentCapabilities({
  requestOwnerIdForUrl: (url) => {
    if (!isAndroidLocalAgentUrl(url)) return undefined;
    const auth = getAuthStatusSnapshot();
    return auth.phase === "authenticated" && auth.identity.kind === "owner"
      ? auth.identity.id
      : undefined;
  },
  isInProcessAgentBase: isIosInProcessLocalAgentBase,
  isTerminalBootError: isTerminalIosNativeAgentBootErrorMessage,
  lifecycleForUrl: androidNativeAgentLifecycleForUrl,
});

configureRuntimeManagement(async (request) => {
  const { executeRuntimeManagementCommand } = await import(
    "../runtime-management"
  );
  return executeRuntimeManagementCommand(request);
});
