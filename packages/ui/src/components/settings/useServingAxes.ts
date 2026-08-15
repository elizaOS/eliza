/**
 * Gathers the live runtime and inference inputs Settings needs to state both
 * serving axes, so `ProviderSwitcher` stays composition-only. Prefers the
 * authoritative `GET /api/runtime/mode` snapshot for the runtime axis and
 * falls back to the startup-coordinator target and persisted first-run /
 * mobile pins while it is loading or unreachable.
 */

import { useEffect, useState } from "react";
import { MOBILE_RUNTIME_MODE_CHANGED_EVENT } from "../../events";
import {
  type MobileRuntimeMode,
  readPersistedMobileRuntimeMode,
} from "../../first-run/mobile-runtime-mode";
import { useRuntimeMode } from "../../hooks/useRuntimeMode";
import { useAppSelectorShallow } from "../../state";
import { resolveServingAxes, type ServingAxes } from "./resolveServingAxes";

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

export function useServingAxes(args: {
  elizaCloudConnected: boolean;
  isCloudSelected: boolean;
  cloudCallsDisabled: boolean;
}): ServingAxes {
  const { firstRunRuntimeTarget, startupTarget } = useAppSelectorShallow(
    (s) => ({
      firstRunRuntimeTarget: s.firstRunRuntimeTarget,
      startupTarget: s.startupCoordinator.target,
    }),
  );
  const { state: runtimeModeState } = useRuntimeMode();
  const mobileRuntimeMode = usePersistedMobileRuntimeMode();

  return resolveServingAxes({
    deploymentRuntime:
      runtimeModeState.phase === "ready"
        ? runtimeModeState.snapshot.deploymentRuntime
        : null,
    startupTarget: startupTarget ?? null,
    firstRunRuntimeTarget: firstRunRuntimeTarget ?? null,
    mobileRuntimeMode,
    elizaCloudConnected: args.elizaCloudConnected,
    isCloudSelected: args.isCloudSelected,
    cloudCallsDisabled: args.cloudCallsDisabled,
  });
}
