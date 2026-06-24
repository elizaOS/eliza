/**
 * Windows Sandbox (WSB) provider backend (#9170 M13).
 *
 * Windows Sandbox is a disposable, hardware-isolated Windows VM shipped with
 * Windows Pro/Enterprise. The host launches it from a `.wsb` config that maps a
 * folder and runs a logon command (here: start the in-guest computer-server),
 * then drives it over the generic remote-guest RPC (`{command,params}` →
 * `{success,result}`) — see `remote-guest.ts`.
 *
 * Availability is gated: WSB only exists on Windows with the optional feature
 * installed. When absent, construction throws `SandboxBackendUnavailableError`
 * so the misconfiguration is loud, never a silent host fallback.
 *
 * The launcher + transport are injectable so the boot/teardown logic is
 * unit-testable without a real Windows Sandbox.
 */

import { existsSync } from "node:fs";
import {
  HttpGuestTransport,
  RemoteGuestBackend,
  type RemoteGuestTransport,
  resolveGuestRpcUrl,
} from "./remote-guest.js";
import { SandboxBackendUnavailableError } from "./types.js";

/** Host-side controller for the WSB VM lifecycle (injectable for tests). */
export interface WsbLauncher {
  /** Launch Windows Sandbox with the computer-server logon command. */
  launch(args: { rpcPort: number }): Promise<void>;
  /** Stop the running sandbox (best-effort; WSB tears down on close). */
  shutdown(): Promise<void>;
}

export interface WsbBackendOptions {
  rpcUrl?: string;
  rpcPort?: number;
  transport?: RemoteGuestTransport;
  launcher?: WsbLauncher;
  /** Availability override (tests). */
  available?: boolean;
}

const DEFAULT_RPC_PORT = 8000;
const WINDOWS_SANDBOX_EXE = "C:/Windows/System32/WindowsSandbox.exe";

/** Best-effort probe: WSB exists only on Windows with the feature installed. */
export function isWindowsSandboxAvailable(): boolean {
  if (process.platform !== "win32") return false;
  return existsSync(WINDOWS_SANDBOX_EXE);
}

export class WSBBackend extends RemoteGuestBackend {
  readonly name = "wsb";
  private readonly rpcPort: number;
  private readonly _transport: RemoteGuestTransport;
  private readonly launcher: WsbLauncher | null;
  private started = false;

  constructor(opts: WsbBackendOptions = {}) {
    super();
    const available = opts.available ?? isWindowsSandboxAvailable();
    if (!available && !opts.launcher && !opts.transport) {
      throw new SandboxBackendUnavailableError(
        "Windows Sandbox is unavailable (needs Windows Pro/Enterprise with the " +
          "'Windows Sandbox' optional feature enabled). " +
          "Set COMPUTER_USE_SANDBOX_BACKEND=docker or enable WSB.",
        "wsb",
      );
    }
    this.rpcPort = opts.rpcPort ?? DEFAULT_RPC_PORT;
    this._transport =
      opts.transport ??
      new HttpGuestTransport({
        url: resolveGuestRpcUrl({ rpcUrl: opts.rpcUrl, rpcPort: this.rpcPort }),
      });
    this.launcher = opts.launcher ?? null;
  }

  protected transport(): RemoteGuestTransport {
    return this._transport;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.launcher) await this.launcher.launch({ rpcPort: this.rpcPort });
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    if (this.launcher) await this.launcher.shutdown();
    this.started = false;
  }
}
