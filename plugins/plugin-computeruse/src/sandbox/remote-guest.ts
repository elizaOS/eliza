/**
 * Remote-guest RPC seam (#9170 M13).
 *
 * trycua/cua's host talks to an in-guest `computer-server` over a single
 * generic RPC: send `{command, params}` and get back `{success, result}`. Every
 * VM/sandbox provider (Windows Sandbox, QEMU, cloud) is just a different way of
 * (a) booting the guest and (b) transporting that one RPC.
 *
 * elizaOS already has a typed `SandboxOp` envelope and a Docker backend that
 * speaks it. This module bridges the two: `RemoteGuestBackend` is a
 * `SandboxBackend` whose `invoke(op)` translates the typed op into the generic
 * `{command, params}` RPC, sends it through a pluggable `RemoteGuestTransport`,
 * and maps the `{success, result}` response back. Provider backends (WSB, QEMU)
 * subclass it and only supply boot/teardown + a transport.
 *
 * The transport is injectable so the whole path is unit-testable with a fake
 * (no VM, no network), and so a provider can swap HTTP for virtio-serial etc.
 */

import type { ScreenRegion } from "../types.js";
import {
  type SandboxBackend,
  SandboxInvocationError,
  type SandboxOp,
} from "./types.js";

/** The generic cua RPC request: a command name + arbitrary params. */
export interface GuestRpcRequest {
  command: string;
  params: Record<string, unknown>;
}

/** The generic cua RPC response. `result` is present on success. */
export interface GuestRpcResponse {
  success: boolean;
  result?: unknown;
  error?: string;
}

/** Transport for the `{command, params}` → `{success, result}` RPC. */
export interface RemoteGuestTransport {
  readonly name: string;
  dispatch(request: GuestRpcRequest): Promise<GuestRpcResponse>;
}

/**
 * Translate a typed `SandboxOp` into the generic cua `{command, params}` RPC.
 * Pure — exported for unit tests. Command names follow cua's computer-server
 * verb vocabulary so a stock cua guest answers them unchanged.
 */
export function sandboxOpToRpc(op: SandboxOp): GuestRpcRequest {
  switch (op.kind) {
    case "screenshot":
      return {
        command: "screenshot",
        params: op.region ? { region: regionParams(op.region) } : {},
      };
    case "mouse_move":
      return { command: "move_cursor", params: { x: op.x, y: op.y } };
    case "mouse_click":
      return { command: "left_click", params: { x: op.x, y: op.y } };
    case "mouse_double_click":
      return { command: "double_click", params: { x: op.x, y: op.y } };
    case "mouse_right_click":
      return { command: "right_click", params: { x: op.x, y: op.y } };
    case "mouse_drag":
      return {
        command: "drag",
        params: { x1: op.x1, y1: op.y1, x2: op.x2, y2: op.y2 },
      };
    case "mouse_scroll":
      return {
        command: "scroll",
        params: {
          x: op.x,
          y: op.y,
          direction: op.direction,
          amount: op.amount,
        },
      };
    case "keyboard_type":
      return { command: "type_text", params: { text: op.text } };
    case "keyboard_key_press":
      return { command: "press_key", params: { key: op.key } };
    case "keyboard_hotkey":
      return { command: "hotkey", params: { combo: op.combo } };
    case "list_windows":
      return { command: "get_windows", params: {} };
    case "focus_window":
      return { command: "focus_window", params: { window_id: op.window_id } };
    case "list_processes":
      return { command: "list_processes", params: {} };
    case "run_command":
      return {
        command: "run_command",
        params: {
          command: op.command,
          ...(op.cwd ? { cwd: op.cwd } : {}),
          ...(op.timeout_seconds !== undefined
            ? { timeout_seconds: op.timeout_seconds }
            : {}),
        },
      };
    case "read_file":
      return { command: "read_file", params: { path: op.path } };
    case "write_file":
      return {
        command: "write_file",
        params: { path: op.path, content: op.content },
      };
    default: {
      // Exhaustiveness guard — a new SandboxOp must add a mapping here.
      const never: never = op;
      throw new Error(`unmapped sandbox op: ${JSON.stringify(never)}`);
    }
  }
}

function regionParams(region: ScreenRegion): Record<string, number> {
  return {
    x: region.x,
    y: region.y,
    width: region.width,
    height: region.height,
  };
}

/** HTTP transport: POSTs the RPC as JSON to a guest URL via `fetch`. */
export class HttpGuestTransport implements RemoteGuestTransport {
  readonly name = "http";
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: {
    url: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }) {
    this.url = opts.url;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async dispatch(request: GuestRpcRequest): Promise<GuestRpcResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!res.ok) {
        return { success: false, error: `guest RPC HTTP ${res.status}` };
      }
      const body = (await res.json()) as GuestRpcResponse;
      return body;
    } catch (err) {
      // error-policy:J1 RPC boundary — the transport failure returns as a
      // structured {success:false,error} the sandbox driver surfaces.
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * A `SandboxBackend` that speaks the generic remote-guest RPC. Subclasses
 * (WSB, QEMU) supply boot/teardown and a transport; everything else — the
 * op→RPC translation and the response unwrap — is shared here.
 */
export abstract class RemoteGuestBackend implements SandboxBackend {
  abstract readonly name: string;
  protected abstract transport(): RemoteGuestTransport;

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;

  async invoke<TResult>(op: SandboxOp): Promise<TResult> {
    const request = sandboxOpToRpc(op);
    const response = await this.transport().dispatch(request);
    if (!response.success) {
      throw new SandboxInvocationError(
        `${this.name} guest RPC "${request.command}" failed: ${
          response.error ?? "unknown error"
        }`,
        op.kind,
      );
    }
    return response.result as TResult;
  }
}

/** Resolve the guest RPC URL from explicit url → port → default. Pure. */
export function resolveGuestRpcUrl(opts: {
  rpcUrl?: string;
  rpcPort?: number;
}): string {
  if (opts.rpcUrl && opts.rpcUrl.trim().length > 0) return opts.rpcUrl.trim();
  const port = opts.rpcPort ?? 8000;
  return `http://127.0.0.1:${port}/cua`;
}
