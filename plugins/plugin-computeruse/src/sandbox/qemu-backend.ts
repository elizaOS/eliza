/**
 * QEMU sandbox backend — Phase 2 stub.
 *
 * Phase 2 will spawn a QEMU/KVM VM (probably via Lume on macOS hosts and
 * raw `qemu-system-*` elsewhere), expose a virtio-serial control socket,
 * and proxy `SandboxOp` envelopes through that. For Phase 1 the constructor
 * intentionally throws so misconfiguration is loud, never silent.
 */

import {
  SandboxBackendUnavailableError,
  type SandboxBackend,
  type SandboxOp,
} from "./types.js";

export interface QemuBackendOptions {
  image: string;
}

export class QemuBackend implements SandboxBackend {
  readonly name = "qemu";

  constructor(_options: QemuBackendOptions) {
    throw new SandboxBackendUnavailableError(
      "QEMU backend ships in Phase 2. Use ELIZA_COMPUTERUSE_MODE=yolo or ELIZA_COMPUTERUSE_SANDBOX_BACKEND=docker for now.",
      "qemu",
    );
  }

  async start(): Promise<void> {
    throw new SandboxBackendUnavailableError(
      "QEMU backend ships in Phase 2.",
      "qemu",
    );
  }

  async stop(): Promise<void> {
    throw new SandboxBackendUnavailableError(
      "QEMU backend ships in Phase 2.",
      "qemu",
    );
  }

  async invoke<TResult>(_op: SandboxOp): Promise<TResult> {
    throw new SandboxBackendUnavailableError(
      "QEMU backend ships in Phase 2.",
      "qemu",
    );
  }
}
