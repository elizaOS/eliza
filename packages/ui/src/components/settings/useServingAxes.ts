/**
 * Gathers the live runtime and inference inputs Settings needs to state both
 * serving axes, so `ProviderSwitcher` stays composition-only.
 *
 * Runtime comes from `GET /api/runtime/mode`, falling back to the
 * startup-coordinator target and persisted first-run / mobile pins while that
 * snapshot loads. Inference comes from `activeChat` on
 * `GET /api/models/config` — the server's answer to who is actually serving.
 * Neither axis is recomputed from account/config booleans here; doing so is
 * what previously made a direct external provider read as "This device".
 */

import { useEffect, useState } from "react";
import { client } from "../../api";
import { isLimitedCloudAgentApiBase } from "../../api/app-shell-capabilities";
import { MOBILE_RUNTIME_MODE_CHANGED_EVENT } from "../../events";
import {
  type MobileRuntimeMode,
  readPersistedMobileRuntimeMode,
} from "../../first-run/mobile-runtime-mode";
import { useRuntimeMode } from "../../hooks/useRuntimeMode";
import { useAppSelectorShallow } from "../../state";
import {
  type ActiveChatSource,
  resolveServingAxes,
  type ServingAxes,
} from "./resolveServingAxes";

/**
 * The persisted mobile runtime mode, resubscribed to its change event so a
 * runtime switch made elsewhere in Settings updates this summary without a
 * reload.
 */
function usePersistedMobileRuntimeMode(): MobileRuntimeMode | null {
  const [mode, setMode] = useState<MobileRuntimeMode | null>(() =>
    readPersistedMobileRuntimeMode(),
  );

  useEffect(() => {
    if (typeof document === "undefined") return;
    const sync = () => setMode(readPersistedMobileRuntimeMode());
    sync();
    document.addEventListener(MOBILE_RUNTIME_MODE_CHANGED_EVENT, sync);
    return () => {
      document.removeEventListener(MOBILE_RUNTIME_MODE_CHANGED_EVENT, sync);
    };
  }, []);

  return mode;
}

/**
 * `activeChat` from `GET /api/models/config`. Held as an explicit
 * resolved/unresolved pair so the summary can say "checking" instead of
 * defaulting to "This device" before the server has answered.
 */
function useActiveChatSource(): {
  activeChat: ActiveChatSource | null;
  activeChatResolved: boolean;
} {
  // Some embedded surface harnesses intentionally provide a minimal client;
  // absence of the optional base accessor means "unknown/full shell", not a
  // reason to crash the composer.
  const agentBase =
    typeof client.getBaseUrl === "function" ? client.getBaseUrl() : "";
  const limitedCloudAgent = isLimitedCloudAgentApiBase(agentBase);
  const [state, setState] = useState<{
    activeChat: ActiveChatSource | null;
    activeChatResolved: boolean;
  }>(() =>
    limitedCloudAgent
      ? {
          activeChat: {
            provider: "Eliza Cloud",
            family: "ELIZAOS_CLOUD",
            endpoint: agentBase,
          },
          activeChatResolved: true,
        }
      : { activeChat: null, activeChatResolved: false },
  );

  useEffect(() => {
    if (limitedCloudAgent) return;
    let disposed = false;
    // The chip mounts on the chat overlay, which is rendered by surfaces and
    // harnesses that stub the API client down to the calls they need. A
    // missing method is "serving source unknown", not a crash that takes the
    // whole composer with it.
    if (typeof client.getModelsConfig !== "function") return;
    client
      .getModelsConfig()
      .then((response) => {
        if (disposed) return;
        setState({
          activeChat: response.activeChat ?? null,
          activeChatResolved: true,
        });
      })
      .catch(() => {
        // error-policy:J4 the serving source is unavailable; stay unresolved
        // so the summary shows "checking" rather than inventing "This device".
        if (!disposed) {
          setState({ activeChat: null, activeChatResolved: false });
        }
      });
    return () => {
      disposed = true;
    };
  }, [limitedCloudAgent]);

  return state;
}

export function useServingAxes(args: {
  elizaCloudConnected: boolean;
  isCloudSelected: boolean;
  cloudCallsDisabled: boolean;
}): ServingAxes {
  // Optional-chained for the same reason the client call below is guarded:
  // the chip mounts on the chat surfaces, whose harnesses seed only the store
  // slice they exercise. A missing coordinator means "runtime target not
  // known yet", which the resolver already handles, not a crash that takes
  // the whole chat view down.
  const { firstRunRuntimeTarget, startupTarget } = useAppSelectorShallow(
    (s) => ({
      firstRunRuntimeTarget: s.firstRunRuntimeTarget,
      startupTarget: s.startupCoordinator?.target,
    }),
  );
  const { state: runtimeModeState } = useRuntimeMode();
  const mobileRuntimeMode = usePersistedMobileRuntimeMode();
  const { activeChat, activeChatResolved } = useActiveChatSource();

  return resolveServingAxes({
    deploymentRuntime:
      runtimeModeState.phase === "ready"
        ? runtimeModeState.snapshot.deploymentRuntime
        : null,
    startupTarget: startupTarget ?? null,
    firstRunRuntimeTarget: firstRunRuntimeTarget ?? null,
    mobileRuntimeMode,
    activeChat,
    activeChatResolved,
    elizaCloudConnected: args.elizaCloudConnected,
    isCloudSelected: args.isCloudSelected,
    cloudCallsDisabled: args.cloudCallsDisabled,
  });
}
