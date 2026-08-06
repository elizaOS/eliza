/**
 * React client for the main-process shell-controller authority. Desktop
 * renderers consume authoritative generations and snapshots; only the current
 * owner mounts the real chat/voice engine. Web and mobile have no authority
 * transport and remain a lone owner with no cross-window traffic.
 */
import * as React from "react";
import {
  createElectrobunShellAuthorityTransport,
  type ShellAuthorityTransport,
} from "./electrobun-transport";
import {
  SHELL_SYNC_PROTOCOL_VERSION,
  type ShellAuthorityDelivery,
  type ShellAuthorityState,
  type ShellControllerCommand,
  type ShellWindowRole,
} from "./protocol";
import {
  parseShellControllerSnapshot,
  type ShellControllerSnapshot,
} from "./snapshot";

export type ShellFollowerStatus =
  | "connected"
  | "connecting"
  | "disconnected"
  | "version-mismatch";

type CommandHandler = (
  command: ShellControllerCommand,
  fromEndpointId: string,
) => Promise<void>;

export interface ShellControllerSync {
  role: ShellWindowRole;
  status: ShellFollowerStatus;
  snapshot: ShellControllerSnapshot | null;
  endpointId: string | null;
  generation: number;
  dispatch: (command: ShellControllerCommand) => Promise<void>;
  publishSnapshot: (snapshot: ShellControllerSnapshot) => void;
  deliver: (
    targetEndpointId: string,
    delivery: ShellAuthorityDelivery,
  ) => Promise<void>;
  setCommandHandler: (handler: CommandHandler | null) => void;
  setDeliveryHandler: (
    handler: ((delivery: ShellAuthorityDelivery) => void) | null,
  ) => void;
  reportError: (message: string, error: unknown) => void;
}

export interface UseShellControllerSyncOptions {
  /** Injected in tests. `undefined` resolves Electrobun; `null` is lone-owner. */
  transport?: ShellAuthorityTransport | null;
  onError?: (message: string, error: unknown) => void;
}

function commandId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `shell-command-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function useShellControllerSync(
  options: UseShellControllerSyncOptions = {},
): ShellControllerSync {
  const onErrorRef = React.useRef(options.onError);
  onErrorRef.current = options.onError;
  const commandHandlerRef = React.useRef<CommandHandler | null>(null);
  const deliveryHandlerRef = React.useRef<
    ((delivery: ShellAuthorityDelivery) => void) | null
  >(null);
  const transportRef = React.useRef<ShellAuthorityTransport | null | undefined>(
    undefined,
  );
  if (transportRef.current === undefined) {
    transportRef.current =
      "transport" in options
        ? (options.transport ?? null)
        : createElectrobunShellAuthorityTransport((error) =>
            onErrorRef.current?.("shell authority transport error", error),
          );
  }
  const transport = transportRef.current;
  const lone = transport === null;
  const authorityRef = React.useRef<{
    endpointId: string | null;
    ownerEndpointId: string | null;
    generation: number;
    snapshotSeq: number;
    role: ShellWindowRole;
  }>({
    endpointId: null,
    ownerEndpointId: null,
    generation: 0,
    snapshotSeq: 0,
    role: lone ? "owner" : "follower",
  });
  const [role, setRole] = React.useState<ShellWindowRole>(
    lone ? "owner" : "follower",
  );
  const [status, setStatus] = React.useState<ShellFollowerStatus>(
    lone ? "connected" : "connecting",
  );
  const [snapshot, setSnapshot] =
    React.useState<ShellControllerSnapshot | null>(null);

  const applyState = React.useCallback((next: ShellAuthorityState): void => {
    const current = authorityRef.current;
    if (current.endpointId && next.endpointId !== current.endpointId) {
      onErrorRef.current?.(
        "shell authority endpoint identity changed",
        new Error(
          `expected ${current.endpointId}, received ${next.endpointId}`,
        ),
      );
      return;
    }
    if (
      next.generation < current.generation ||
      (next.generation === current.generation &&
        next.snapshotSeq < current.snapshotSeq)
    ) {
      return;
    }

    let parsedSnapshot: ShellControllerSnapshot | null = null;
    if (next.role === "follower" && next.snapshot !== null) {
      parsedSnapshot = parseShellControllerSnapshot(next.snapshot);
      if (!parsedSnapshot) {
        onErrorRef.current?.(
          "shell authority supplied an invalid snapshot",
          new Error("snapshot rejected"),
        );
        setStatus("disconnected");
        setSnapshot(null);
        return;
      }
    }
    authorityRef.current = {
      endpointId: next.endpointId,
      ownerEndpointId: next.ownerEndpointId,
      generation: next.generation,
      snapshotSeq: next.snapshotSeq,
      role: next.role,
    };
    setRole(next.role);
    setStatus(next.status);
    setSnapshot(parsedSnapshot);
  }, []);

  React.useEffect(() => {
    if (!transport) return;
    let active = true;
    const unsubscribe = transport.subscribe({
      onState: (next) => {
        if (active) applyState(next);
      },
      onCommand: (request) => {
        const current = authorityRef.current;
        if (
          !active ||
          current.role !== "owner" ||
          request.generation !== current.generation
        ) {
          return;
        }
        const handler = commandHandlerRef.current;
        const completion = handler
          ? handler(request.command, request.fromEndpointId)
          : Promise.reject(new Error("owner controller is not mounted"));
        void completion
          .then(() =>
            transport.completeCommand(
              request.generation,
              request.commandId,
              request.fromEndpointId,
              { ok: true },
            ),
          )
          .catch((error: unknown) =>
            transport.completeCommand(
              request.generation,
              request.commandId,
              request.fromEndpointId,
              {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              },
            ),
          )
          .then((result) => {
            if (!result.ok)
              throw new Error("authority rejected command completion");
          })
          .catch((error: unknown) =>
            onErrorRef.current?.("shell command completion failed", error),
          );
      },
      onDelivery: (generation, delivery) => {
        const current = authorityRef.current;
        if (
          active &&
          current.role === "follower" &&
          generation === current.generation
        ) {
          deliveryHandlerRef.current?.(delivery);
        }
      },
      onPing: () => {
        void transport
          .heartbeat(SHELL_SYNC_PROTOCOL_VERSION)
          .then((next) => {
            if (active) applyState(next);
          })
          .catch((error: unknown) =>
            onErrorRef.current?.("shell authority heartbeat failed", error),
          );
      },
    });
    void transport
      .connect(SHELL_SYNC_PROTOCOL_VERSION)
      .then((next) => {
        if (active) applyState(next);
      })
      .catch((error: unknown) => {
        if (active) {
          setStatus("disconnected");
          onErrorRef.current?.("shell authority connection failed", error);
        }
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [applyState, transport]);

  const dispatch = React.useCallback(
    async (command: ShellControllerCommand): Promise<void> => {
      const current = authorityRef.current;
      if (!transport || current.role === "owner") {
        const handler = commandHandlerRef.current;
        if (!handler) throw new Error("shell controller is not mounted");
        await handler(command, current.endpointId ?? "local");
        return;
      }
      const result = await transport.dispatchCommand(commandId(), command);
      if (!result.ok) throw new Error(result.error ?? "owner command failed");
    },
    [transport],
  );
  const publishSnapshot = React.useCallback(
    (next: ShellControllerSnapshot): void => {
      if (!transport) return;
      const { generation, role: currentRole } = authorityRef.current;
      if (currentRole !== "owner") return;
      void transport
        .publishSnapshot(generation, next)
        .then((result) => {
          if (!result.ok) throw new Error("authority rejected owner snapshot");
        })
        .catch((error: unknown) =>
          onErrorRef.current?.("shell snapshot publish failed", error),
        );
    },
    [transport],
  );
  const deliver = React.useCallback(
    async (
      targetEndpointId: string,
      delivery: ShellAuthorityDelivery,
    ): Promise<void> => {
      if (!transport)
        throw new Error("targeted delivery requires desktop authority");
      const { generation, role: currentRole } = authorityRef.current;
      if (currentRole !== "owner") throw new Error("only owner can deliver");
      const result = await transport.deliver(
        generation,
        targetEndpointId,
        delivery,
      );
      if (!result.ok) throw new Error("authority rejected targeted delivery");
    },
    [transport],
  );
  const setCommandHandler = React.useCallback(
    (handler: CommandHandler | null) => {
      commandHandlerRef.current = handler;
    },
    [],
  );
  const setDeliveryHandler = React.useCallback(
    (handler: ((delivery: ShellAuthorityDelivery) => void) | null) => {
      deliveryHandlerRef.current = handler;
    },
    [],
  );
  const reportError = React.useCallback((message: string, error: unknown) => {
    onErrorRef.current?.(message, error);
  }, []);

  return {
    role,
    status,
    snapshot,
    endpointId: authorityRef.current.endpointId,
    generation: authorityRef.current.generation,
    dispatch,
    publishSnapshot,
    deliver,
    setCommandHandler,
    setDeliveryHandler,
    reportError,
  };
}
