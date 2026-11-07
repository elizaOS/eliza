import { useEffect } from "react";
import { client } from "../api/client";
import { type ConnectRequestResult, listenForConnectRequests } from "../events";
import {
  clearPendingRemoteFirstRun,
  completeRemoteAgentFirstRun,
} from "../first-run/adopt-remote-first-run";
import { persistMobileRuntimeModeForServerTarget } from "../first-run/mobile-runtime-mode";
import { applyLaunchConnection } from "../platform/browser-launch";
import { confirmDesktopAction } from "../utils/desktop-dialogs";
import { useAppSelectorShallow } from "./app-store";
import { isLoopbackHostname } from "./runtime-url-trust";

/**
 * A loopback gateway is the local-agent-on-this-machine case — the common,
 * benign target a `connect` deep link points at. Anything else (LAN, Tailscale,
 * .local, a public host) repoints the app at a different server and must be
 * user-confirmed (see the CONNECT_EVENT handler).
 */
function isLoopbackGatewayHost(gatewayUrl: string): boolean {
  try {
    return isLoopbackHostname(new URL(gatewayUrl).hostname);
  } catch {
    // error-policy:J3 unparseable gateway URL cannot be proven loopback —
    // fail closed so the connect deep link requires user confirmation.
    return false;
  }
}

function gatewayHostForDisplay(gatewayUrl: string): string {
  try {
    return new URL(gatewayUrl).host || gatewayUrl;
  } catch {
    return gatewayUrl;
  }
}

export function useRemoteConnectRequests(enabled = true): void {
  const {
    completeFirstRun,
    retryStartup,
    setActionNotice,
    setState,
    uiLanguage,
  } = useAppSelectorShallow((s) => ({
    completeFirstRun: s.completeFirstRun,
    retryStartup: s.retryStartup,
    setActionNotice: s.setActionNotice,
    setState: s.setState,
    uiLanguage: s.uiLanguage,
  }));
  useEffect(() => {
    if (!enabled) return;
    const handleConnect = async (payload: {
      gatewayUrl: string;
      token?: string;
      completeFirstRun?: boolean;
      skipConfirm?: boolean;
    }): Promise<ConnectRequestResult> => {
      // `completeFirstRun` marks the connected remote as this device's finished
      // first-run target (device/desktop remote-connect-at-URL onboarding), so
      // it lands on home instead of re-showing onboarding on the next launch.
      const shouldCompleteFirstRun = payload.completeFirstRun === true;
      // `skipConfirm` is set ONLY by trusted in-app callers (the Settings
      // "Connect a remote agent" entry, where the user just typed the URL).
      // OS-delivered deep links never set it, so they keep the confirmation.
      const skipConfirm = payload.skipConfirm === true;

      // CONNECT_EVENT is dispatched from an OS-delivered `connect`/`first-run`
      // deep link (attacker-reachable) as well as the trusted Settings entry.
      // Repointing the agent API base to a non-loopback host is
      // security-sensitive, so require explicit user confirmation for any remote
      // target from an untrusted source; the local-agent (loopback) connect and
      // the trusted in-app entry stay frictionless.
      if (!skipConfirm && !isLoopbackGatewayHost(payload.gatewayUrl)) {
        const approved = await confirmDesktopAction({
          type: "warning",
          title: "Connect to this server?",
          message: `Point this app at "${gatewayHostForDisplay(payload.gatewayUrl)}"?`,
          detail:
            "A link asked to connect this app to a different agent server. Only continue if you trust it — that server will handle your messages and data.",
          confirmLabel: "Connect",
          cancelLabel: "Cancel",
        });
        if (!approved) {
          setActionNotice("Connection request cancelled.", "info", 4200);
          return { status: "cancelled" };
        }
      }

      try {
        clearPendingRemoteFirstRun();
        const connection = applyLaunchConnection({
          kind: "remote",
          apiBase: payload.gatewayUrl,
          token: typeof payload.token === "string" ? payload.token : null,
        });
        persistMobileRuntimeModeForServerTarget("remote");
        setState("firstRunRuntimeTarget", "remote");
        setState("firstRunRemoteApiBase", connection.apiBase);
        setState("firstRunRemoteToken", connection.token ?? "");
        setState("firstRunRemoteError", null);
        if (shouldCompleteFirstRun) {
          // Adopt the remote as this device's completed first-run target. Probes
          // first, so an already-configured host is used as-is (no clobber) and
          // a fresh host is marked complete — either way the startup re-poll
          // below lands on home rather than onboarding.
          await completeRemoteAgentFirstRun(
            client,
            {
              apiBase: connection.apiBase,
              token: connection.token,
              uiLanguage,
            },
            completeFirstRun,
          );
        }
        setState("firstRunRemoteConnected", true);
        setActionNotice("Connected to remote backend.", "success", 4200);
        retryStartup();
        return { status: "connected" };
      } catch (err) {
        // error-policy:J1 expose failed adoption to both the initiating form and shell notice.
        const message =
          err instanceof Error
            ? err.message
            : "Failed to connect remote backend.";
        setState("firstRunRemoteConnected", false);
        setState("firstRunRemoteError", message);
        setActionNotice(message, "error", 8000);
        return { status: "failed", message };
      }
    };

    return listenForConnectRequests(handleConnect);
  }, [
    enabled,
    completeFirstRun,
    retryStartup,
    setActionNotice,
    setState,
    uiLanguage,
  ]);
}
