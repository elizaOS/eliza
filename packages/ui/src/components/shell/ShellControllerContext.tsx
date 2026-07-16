/**
 * Provides the one shell chat/voice controller to every overlay, launcher
 * surface, and conversation-nav consumer — and, on the multi-window desktop,
 * guarantees a SINGLE engine across windows (#16442).
 *
 * A window is elected owner or follower by `useShellControllerSync`. The OWNER
 * mounts the real `useShellController` engine (the sole microphone/audio owner),
 * publishes its state, and applies followers' commands. A FOLLOWER never mounts
 * the engine: it renders the owner's published snapshot and forwards typed
 * commands. Owner and follower are distinct components at this position, so a
 * genuine handoff (owner window closes) tears the engine down in the old owner
 * and stands it up in the promoted window — never two mics at once. With no
 * cross-window transport (web, mobile, single-window) the window is a lone owner
 * and this behaves exactly as it did before.
 */
import * as React from "react";

import { useAppSelectorShallow } from "../../state/app-store";
import { applyShellControllerCommand } from "./shell-controller-sync/apply-command";
import { buildFollowerController } from "./shell-controller-sync/follower-controller";
import type { ShellControllerCommand } from "./shell-controller-sync/protocol";
import {
  deriveShellControllerSnapshot,
  snapshotsEqual,
} from "./shell-controller-sync/snapshot";
import {
  type ShellControllerSync,
  useShellControllerSync,
} from "./shell-controller-sync/useShellControllerSync";
import { ShellControllerContext } from "./ShellControllerContext.hooks";
import { useShellController } from "./useShellController";

/**
 * Owner path: run the real engine, publish its snapshot to followers (coalescing
 * the many per-token updates a streaming reply emits), and apply followers'
 * commands against it. Provides the live controller unchanged.
 */
export function OwnerShellControllerProvider({
  sync,
  children,
}: {
  sync: ShellControllerSync;
  children: React.ReactNode;
}): React.JSX.Element {
  const controller = useShellController();
  const controllerRef = React.useRef(controller);
  controllerRef.current = controller;

  // Register the command sink once; the closure reads the live controller via a
  // ref so a follower's command always hits the current engine.
  React.useLayoutEffect(() => {
    sync.setCommandHandler((command: ShellControllerCommand) =>
      applyShellControllerCommand(controllerRef.current, command),
    );
    return () => sync.setCommandHandler(null);
  }, [sync]);

  // Publish on any engine change; the equality guard keeps an unchanged tick
  // (and an unchanged streamed token) off the wire.
  const lastPublishedRef = React.useRef<ReturnType<
    typeof deriveShellControllerSnapshot
  > | null>(null);
  React.useEffect(() => {
    const snapshot = deriveShellControllerSnapshot(controller);
    if (
      lastPublishedRef.current &&
      snapshotsEqual(lastPublishedRef.current, snapshot)
    ) {
      return;
    }
    lastPublishedRef.current = snapshot;
    sync.publishSnapshot(snapshot);
  });

  return (
    <ShellControllerContext.Provider value={controller}>
      {children}
    </ShellControllerContext.Provider>
  );
}

/**
 * Follower path: render the owner's snapshot and forward commands. Never mounts
 * the engine, so it can neither open a mic nor start a second chat session. A
 * null controller (no snapshot yet, or a version-mismatch/disconnected owner)
 * degrades the overlay to hidden rather than rendering stale state.
 */
export function FollowerShellControllerProvider({
  sync,
  onCommandError,
  children,
}: {
  sync: ShellControllerSync;
  onCommandError: (command: ShellControllerCommand, error: unknown) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const controller = React.useMemo(() => {
    if (!sync.snapshot) return null;
    return buildFollowerController({
      snapshot: sync.snapshot,
      dispatch: sync.dispatch,
      onCommandError,
    });
  }, [sync.snapshot, sync.dispatch, onCommandError]);

  return (
    <ShellControllerContext.Provider value={controller}>
      {children}
    </ShellControllerContext.Provider>
  );
}

/**
 * Provides a single shell controller to the shell pill / overlay. On the desktop
 * it elects one engine owner across windows; everywhere else it is the lone
 * owner. See the module header for the ownership + handoff contract.
 */
export function ShellControllerProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const { setActionNotice } = useAppSelectorShallow((s) => ({
    setActionNotice: s.setActionNotice,
  }));
  const sync = useShellControllerSync();

  const onCommandError = React.useCallback(
    (_command: ShellControllerCommand, _error: unknown) => {
      setActionNotice?.(
        "Couldn't reach the assistant. Bring its window to the front and try again.",
        "error",
        4000,
      );
    },
    [setActionNotice],
  );

  if (sync.role === "owner") {
    return (
      <OwnerShellControllerProvider sync={sync}>
        {children}
      </OwnerShellControllerProvider>
    );
  }
  return (
    <FollowerShellControllerProvider sync={sync} onCommandError={onCommandError}>
      {children}
    </FollowerShellControllerProvider>
  );
}
