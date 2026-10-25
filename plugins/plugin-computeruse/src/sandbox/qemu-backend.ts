/**
 * QEMU provider backend (#9170 M13).
 *
 * QEMU boots a full guest VM (any OS image) and forwards a host port to the
 * in-guest computer-server (`-netdev user,hostfwd=tcp::<port>-:<port>`). The
 * host then drives it over the generic remote-guest RPC (`{command,params}` →
 * `{success,result}`) — see `remote-guest.ts`.
 *
 * Availability is gated on a `qemu-system-*` binary being present; absent, the
 * backend throws `SandboxBackendUnavailableError` rather than silently falling
 * back to the host. The launcher + transport are injectable so boot/teardown is
 * unit-testable without a real hypervisor.
 */

import {
  HttpGuestTransport,
  RemoteGuestBackend,
  type RemoteGuestTransport,
  resolveGuestRpcUrl,
} from "./remote-guest.js";
import { SandboxBackendUnavailableError } from "./types.js";

/** Host-side controller for the QEMU VM lifecycle (injectable for tests). */
export interface QemuLauncher {
  /** Boot QEMU with the guest image + host-forwarded RPC port. */
  launch(args: { image: string; rpcPort: number }): Promise<void>;
  /** Power off / kill the VM. */
  shutdown(): Promise<void>;
  /** Probe whether a usable qemu-system binary exists. */
  isAvailable(): boolean;
}

export interface QemuBackendOptions {
  image: string;
  rpcUrl?: string;
  rpcPort?: number;
  transport?: RemoteGuestTransport;
  launcher?: QemuLauncher;
  /** Availability override (tests). */
  available?: boolean;
}

const DEFAULT_RPC_PORT = 8000;

export class QEMUBackend extends RemoteGuestBackend {
  readonly name = "qemu";
  private readonly image: string;
  private readonly rpcPort: number;
  private readonly _transport: RemoteGuestTransport;
  private readonly launcher: QemuLauncher | null;
  private started = false;

  constructor(opts: QemuBackendOptions) {
    super();
    const available = opts.available ?? opts.launcher?.isAvailable() ?? false;
    if (!available && !opts.transport) {
      throw new SandboxBackendUnavailableError(
        "QEMU is unavailable (no qemu-system-* binary found). " +
          "Install QEMU or set COMPUTER_USE_SANDBOX_BACKEND=docker.",
        "qemu",
      );
    }
    this.image = opts.image;
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
    if (this.launcher) {
      await this.launcher.launch({ image: this.image, rpcPort: this.rpcPort });
    }
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    if (this.launcher) await this.launcher.shutdown();
    this.started = false;
  }
}
