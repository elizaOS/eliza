import { type ShellAction, type ShellState } from "./shell-state";
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
export declare function useShellState(): UseShellStateResult;
//# sourceMappingURL=useShellState.d.ts.map