import {
  configureHostAgentCapabilities,
  configureHostTransport,
  configureRuntimeManagement,
} from "@elizaos/ui";
import {
  androidNativeAgentLifecycleForUrl,
  androidNativeAgentTransportForUrl,
} from "./android-native-agent-transport";
import { nativeClockTransportForUrl } from "./clock-native-host";
import { desktopHttpTransportForUrl } from "./desktop-http-transport";
import { desktopLocalAgentTransportForUrl } from "./desktop-local-agent-transport";
import {
  iosInProcessAgentTransportForUrl,
  isIosInProcessLocalAgentBase,
  isTerminalIosNativeAgentBootErrorMessage,
} from "./ios-local-agent-transport";
import { nativeCloudHttpTransportForUrl } from "./native-cloud-http-transport";
import { remoteRelayTransportForUrl } from "./remote-relay-transport";
import { sshRuntimeTransportForUrl } from "./ssh-runtime-transport";

// Keep local, selected remote runtime, desktop Cloud, and native Cloud precedence.
// CSRF requests deliberately do not use relay/SSH selection; Cloud requests use
// only the desktop bridge before their own Capacitor/browser fallback.
configureHostTransport(async (url, purpose, init) => {
  if (purpose === "cloud") return desktopHttpTransportForUrl(url);
  const native =
    (await androidNativeAgentTransportForUrl(url)) ??
    (await iosInProcessAgentTransportForUrl(url));
  if (native) return native;
  const local = await desktopLocalAgentTransportForUrl(url);
  if (local) return local;
  if (purpose === "agent") {
    const remote =
      remoteRelayTransportForUrl(url) ?? sshRuntimeTransportForUrl(url);
    if (remote) return remote;
  }
  return (
    desktopHttpTransportForUrl(url) ??
    (await nativeClockTransportForUrl(url, init)) ??
    nativeCloudHttpTransportForUrl(url)
  );
});

configureHostAgentCapabilities({
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
