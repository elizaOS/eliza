import * as React from "react";

import {
  NETWORK_STATUS_CHANGE_EVENT,
  type NetworkStatusChangeDetail,
} from "../../events";
import {
  type ShellAction,
  type ShellState,
  initialShellState,
  shellReducer,
} from "./shell-state";

export interface UseShellStateResult {
  state: ShellState;
  send: (action: ShellAction) => void;
}

/**
 * Hook that owns the shell state. Subscribes to the network-status event so
 * the pill can dim/grey when offline.
 *
 * `BOOT_READY` is NOT dispatched from here on purpose — wiring to Shaw's
 * `useApp().startupCoordinator.phase` is the App.tsx mount-site's
 * responsibility, because (a) `useApp()` is provided higher in the tree and
 * (b) this hook should stay testable without an `AppProvider`.
 */
export function useShellState(): UseShellStateResult {
  const [state, dispatch] = React.useReducer(shellReducer, initialShellState);

  React.useEffect(() => {
    if (typeof document === "undefined") return undefined;
    function onNetwork(event: Event): void {
      const detail = (event as CustomEvent<NetworkStatusChangeDetail>).detail;
      if (!detail || typeof detail.connected !== "boolean") return;
      dispatch({ type: "NETWORK", isOnline: detail.connected });
    }
    document.addEventListener(NETWORK_STATUS_CHANGE_EVENT, onNetwork);
    return () => {
      document.removeEventListener(NETWORK_STATUS_CHANGE_EVENT, onNetwork);
    };
  }, []);

  return React.useMemo(
    () => ({
      state,
      // Wrap dispatch so the public `send` signature is exactly
      // `(action: ShellAction) => void` and not tied to React.Dispatch.
      send: (action: ShellAction) => dispatch(action),
    }),
    [state],
  );
}
