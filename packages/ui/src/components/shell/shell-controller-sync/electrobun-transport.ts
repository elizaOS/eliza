/**
 * Renderer client for the native shell-controller authority. The main process,
 * not a webview, owns controller leadership, generations, command idempotency,
 * and targeted voice-result delivery. Every push is decoded before it reaches
 * React; every async controller command resolves only after the owner reports
 * its terminal outcome.
 */
import {
  type ElectrobunRendererRpc,
  getElectrobunRendererRpc,
} from "../../../bridge/electrobun-rpc";
import {
  parseShellAuthorityCommandRequest,
  parseShellAuthorityDelivery,
  parseShellAuthorityState,
  type ShellAuthorityCommandRequest,
  type ShellAuthorityDelivery,
  type ShellAuthorityState,
  type ShellControllerCommand,
} from "./protocol";
import type { ShellControllerSnapshot } from "./snapshot";

export const SHELL_AUTHORITY_STATE_MESSAGE = "shellControllerAuthorityState";
export const SHELL_AUTHORITY_COMMAND_MESSAGE =
  "shellControllerAuthorityCommand";
export const SHELL_AUTHORITY_DELIVERY_MESSAGE =
  "shellControllerAuthorityDelivery";
export const SHELL_AUTHORITY_PING_MESSAGE = "shellControllerAuthorityPing";

interface AuthorityCommandResult {
  ok: boolean;
  error?: string;
}

export interface ShellAuthorityTransportHandlers {
  onState: (state: ShellAuthorityState) => void;
  onCommand: (request: ShellAuthorityCommandRequest) => void;
  onDelivery: (generation: number, delivery: ShellAuthorityDelivery) => void;
  onPing: () => void;
}

export interface ShellAuthorityTransport {
  connect(protocolVersion: string): Promise<ShellAuthorityState>;
  heartbeat(protocolVersion: string): Promise<ShellAuthorityState>;
  publishSnapshot(
    generation: number,
    snapshot: ShellControllerSnapshot,
  ): Promise<{ ok: boolean }>;
  dispatchCommand(
    commandId: string,
    command: ShellControllerCommand,
  ): Promise<AuthorityCommandResult>;
  completeCommand(
    generation: number,
    commandId: string,
    fromEndpointId: string,
    result: AuthorityCommandResult,
  ): Promise<{ ok: boolean }>;
  deliver(
    generation: number,
    targetEndpointId: string,
    delivery: ShellAuthorityDelivery,
  ): Promise<{ ok: boolean }>;
  subscribe(handlers: ShellAuthorityTransportHandlers): () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOk(value: unknown): { ok: boolean } {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new Error("shell authority returned an invalid response");
  }
  return { ok: value.ok };
}

function parseCommandResult(value: unknown): AuthorityCommandResult {
  if (
    !isRecord(value) ||
    typeof value.ok !== "boolean" ||
    !(value.error === undefined || typeof value.error === "string")
  ) {
    throw new Error("shell authority returned an invalid command outcome");
  }
  return value.ok
    ? { ok: true }
    : { ok: false, error: value.error ?? "owner-command-failed" };
}

function request(
  rpc: ElectrobunRendererRpc,
  method: string,
  params: unknown,
): Promise<unknown> {
  const handler = rpc.request?.[method];
  if (!handler)
    return Promise.reject(new Error(`missing desktop RPC: ${method}`));
  return handler.call(rpc.request, params);
}

export function buildElectrobunShellAuthorityTransport(
  rpc: ElectrobunRendererRpc,
  onError: (error: unknown) => void,
): ShellAuthorityTransport {
  return {
    async connect(protocolVersion) {
      const state = parseShellAuthorityState(
        await request(rpc, "shellControllerConnect", { protocolVersion }),
      );
      if (!state) throw new Error("shell authority returned invalid state");
      return state;
    },
    async heartbeat(protocolVersion) {
      const state = parseShellAuthorityState(
        await request(rpc, "shellControllerHeartbeat", { protocolVersion }),
      );
      if (!state) throw new Error("shell authority returned invalid state");
      return state;
    },
    async publishSnapshot(generation, snapshot) {
      return parseOk(
        await request(rpc, "shellControllerPublishSnapshot", {
          generation,
          snapshot,
        }),
      );
    },
    async dispatchCommand(commandId, command) {
      return parseCommandResult(
        await request(rpc, "shellControllerDispatchCommand", {
          commandId,
          command,
        }),
      );
    },
    async completeCommand(generation, commandId, fromEndpointId, result) {
      return parseOk(
        await request(rpc, "shellControllerCompleteCommand", {
          generation,
          commandId,
          fromEndpointId,
          ...result,
        }),
      );
    },
    async deliver(generation, targetEndpointId, delivery) {
      return parseOk(
        await request(rpc, "shellControllerDeliver", {
          generation,
          targetEndpointId,
          delivery,
        }),
      );
    },
    subscribe(handlers) {
      const onState = (payload: unknown): void => {
        const state = parseShellAuthorityState(payload);
        if (state) handlers.onState(state);
        else onError(new Error("shell authority pushed invalid state"));
      };
      const onCommand = (payload: unknown): void => {
        const command = parseShellAuthorityCommandRequest(payload);
        if (command) handlers.onCommand(command);
        else onError(new Error("shell authority pushed invalid command"));
      };
      const onDelivery = (payload: unknown): void => {
        if (!isRecord(payload) || !Number.isSafeInteger(payload.generation)) {
          onError(
            new Error("shell authority pushed invalid delivery envelope"),
          );
          return;
        }
        const delivery = parseShellAuthorityDelivery(payload.delivery);
        if (delivery)
          handlers.onDelivery(payload.generation as number, delivery);
        else onError(new Error("shell authority pushed invalid delivery"));
      };
      const onPing = (): void => handlers.onPing();
      rpc.onMessage(SHELL_AUTHORITY_STATE_MESSAGE, onState);
      rpc.onMessage(SHELL_AUTHORITY_COMMAND_MESSAGE, onCommand);
      rpc.onMessage(SHELL_AUTHORITY_DELIVERY_MESSAGE, onDelivery);
      rpc.onMessage(SHELL_AUTHORITY_PING_MESSAGE, onPing);
      return () => {
        rpc.offMessage(SHELL_AUTHORITY_STATE_MESSAGE, onState);
        rpc.offMessage(SHELL_AUTHORITY_COMMAND_MESSAGE, onCommand);
        rpc.offMessage(SHELL_AUTHORITY_DELIVERY_MESSAGE, onDelivery);
        rpc.offMessage(SHELL_AUTHORITY_PING_MESSAGE, onPing);
      };
    },
  };
}

export function createElectrobunShellAuthorityTransport(
  onError: (error: unknown) => void,
): ShellAuthorityTransport | null {
  const rpc = getElectrobunRendererRpc();
  return rpc ? buildElectrobunShellAuthorityTransport(rpc, onError) : null;
}
