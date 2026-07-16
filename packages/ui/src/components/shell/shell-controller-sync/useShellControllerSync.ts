/**
 * React host for the shell-controller coordinator (#16442): owns one
 * `ShellControllerCoordinator` for this window's lifetime, drives its clock, and
 * exposes the elected role, the follower link status, the latest shared
 * snapshot, and the command/publish handles the owner + follower providers use.
 *
 * When no cross-window transport exists (web, mobile, single-window dev) the
 * window is a lone owner with no bus traffic, so behaviour is identical to
 * before this change everywhere except the multi-window desktop. On the desktop,
 * a joining window waits `DISCOVERY_GRACE_MS` before it may claim ownership so it
 * hears an existing owner first and never flashes a second engine.
 */
import * as React from "react";
import {
  resolveWindowShellRoute,
  type WindowShellRoute,
} from "../../../platform/window-shell";
import {
  ShellControllerCoordinator,
  type ShellFollowerStatus,
} from "./coordinator";
import { createElectrobunShellSyncTransport } from "./electrobun-transport";
import {
  SHELL_OWNER_PRIORITY,
  type ShellControllerCommand,
  type ShellWindowRole,
} from "./protocol";
import type { ShellControllerSnapshot } from "./snapshot";
import type { ShellSyncTransport } from "./transport";

const DISCOVERY_GRACE_MS = 300;
const TICK_INTERVAL_MS = 2000;

export interface ShellControllerSync {
  role: ShellWindowRole;
  status: ShellFollowerStatus;
  snapshot: ShellControllerSnapshot | null;
  dispatch: (command: ShellControllerCommand) => Promise<void>;
  publishSnapshot: (snapshot: ShellControllerSnapshot) => void;
  setCommandHandler: (
    handler: ((command: ShellControllerCommand) => void) | null,
  ) => void;
}

export interface UseShellControllerSyncOptions {
  /** Injected in tests. `undefined` resolves the real Electrobun transport;
   *  `null` forces the lone-owner path. */
  transport?: ShellSyncTransport | null;
  windowId?: string;
  priority?: number;
  onError?: (message: string, error: unknown) => void;
}

/** Priority of this window as an owner candidate, from its shell route. */
export function resolveShellSyncPriority(route: WindowShellRoute): number {
  switch (route.mode) {
    case "main":
      return SHELL_OWNER_PRIORITY.main;
    case "chat-overlay":
      return SHELL_OWNER_PRIORITY["chat-overlay"];
    case "tray-popover":
      return SHELL_OWNER_PRIORITY["tray-popover"];
    default:
      return SHELL_OWNER_PRIORITY.surface;
  }
}

function generateWindowId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const NULL_TRANSPORT: ShellSyncTransport = {
  send: () => {},
  subscribe: () => () => {},
};

interface CoordinatorHandle {
  coord: ShellControllerCoordinator;
  isLone: boolean;
  claimImmediately: boolean;
}

export function useShellControllerSync(
  options: UseShellControllerSyncOptions = {},
): ShellControllerSync {
  const onErrorRef = React.useRef(options.onError);
  onErrorRef.current = options.onError;

  const commandHandlerRef = React.useRef<
    ((command: ShellControllerCommand) => void) | null
  >(null);
  // Coordinator callbacks read the state setters through refs so the coordinator
  // (built in a lazy ref before the useState calls) never references a binding
  // before its declaration.
  const setRoleRef = React.useRef<(r: ShellWindowRole) => void>(() => {});
  const setStatusRef = React.useRef<(s: ShellFollowerStatus) => void>(() => {});
  const setSnapshotRef = React.useRef<
    (s: ShellControllerSnapshot | null) => void
  >(() => {});

  // One coordinator + transport for this window's whole lifetime (lazy-init ref,
  // so options are read exactly once and the instance is never recreated).
  const handleRef = React.useRef<CoordinatorHandle | null>(null);
  if (handleRef.current === null) {
    const transport =
      "transport" in options
        ? (options.transport ?? NULL_TRANSPORT)
        : (createElectrobunShellSyncTransport((error) =>
            onErrorRef.current?.("shell-sync transport error", error),
          ) ?? NULL_TRANSPORT);
    const isLone = transport === NULL_TRANSPORT;
    const priority =
      options.priority ?? resolveShellSyncPriority(resolveWindowShellRoute());
    // A lone window (no peers) and the `main` window (nothing outranks priority
    // 0) both own immediately — no discovery wait — so the common case never
    // flashes a connecting state or remounts the app subtree. Secondary desktop
    // windows discover an existing owner first.
    const claimImmediately = isLone || priority === SHELL_OWNER_PRIORITY.main;
    handleRef.current = {
      isLone,
      claimImmediately,
      coord: new ShellControllerCoordinator({
        windowId: options.windowId ?? generateWindowId(),
        priority,
        transport,
        now: () => Date.now(),
        claimOwnershipImmediately: claimImmediately,
        onRoleChange: (nextRole) => setRoleRef.current(nextRole),
        onStatusChange: (nextStatus) => setStatusRef.current(nextStatus),
        onSnapshot: (nextSnapshot) => setSnapshotRef.current(nextSnapshot),
        onCommand: (command) => {
          const handler = commandHandlerRef.current;
          if (!handler) {
            throw new Error(
              "shell-sync: no command handler registered (owner not mounted)",
            );
          }
          handler(command);
        },
        onError: (message, error) => onErrorRef.current?.(message, error),
      }),
    };
  }
  const handle = handleRef.current;

  // Initialise role from the claim policy so a lone/main window renders as owner
  // on the very first paint (no follower→owner remount).
  const [role, setRole] = React.useState<ShellWindowRole>(
    handle.claimImmediately ? "owner" : "follower",
  );
  const [status, setStatus] = React.useState<ShellFollowerStatus>("connecting");
  const [snapshot, setSnapshot] =
    React.useState<ShellControllerSnapshot | null>(null);
  setRoleRef.current = setRole;
  setStatusRef.current = setStatus;
  setSnapshotRef.current = setSnapshot;

  React.useEffect(() => {
    const { coord, isLone } = handle;
    coord.start();
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let interval: ReturnType<typeof setInterval> | undefined;
    if (!isLone) {
      graceTimer = setTimeout(() => coord.completeDiscovery(), DISCOVERY_GRACE_MS);
      interval = setInterval(() => coord.tick(), TICK_INTERVAL_MS);
    }
    return () => {
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      if (interval !== undefined) clearInterval(interval);
      coord.stop();
    };
  }, [handle]);

  const dispatch = React.useCallback(
    (command: ShellControllerCommand) => handle.coord.dispatchCommand(command),
    [handle],
  );
  const publishSnapshot = React.useCallback(
    (next: ShellControllerSnapshot) => handle.coord.publishSnapshot(next),
    [handle],
  );
  const setCommandHandler = React.useCallback(
    (handler: ((command: ShellControllerCommand) => void) | null) => {
      commandHandlerRef.current = handler;
    },
    [],
  );

  return { role, status, snapshot, dispatch, publishSnapshot, setCommandHandler };
}
