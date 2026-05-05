import { type IAgentRuntime, Service } from "@elizaos/core";
import type { WalletBackend } from "../wallet/backend.js";
import { resolveWalletBackend } from "../wallet/select-backend.js";
import "../core-augmentation.js";

/**
 * Runtime service exposing {@link WalletBackend}. Retrieve via
 * `runtime.getService("wallet-backend")`.
 */
export class WalletBackendService extends Service {
  static override serviceType = "wallet-backend";

  override capabilityDescription =
    "Unified wallet backend (EVM + Solana, local or Steward)";

  private backend!: WalletBackend;

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<WalletBackendService> {
    const backend = await resolveWalletBackend(runtime);
    const svc = new WalletBackendService(runtime);
    svc.backend = backend;
    return svc;
  }

  getWalletBackend(): WalletBackend {
    return this.backend;
  }

  override async stop(): Promise<void> {
    // No persistent connections for local / Steward HTTP clients today.
  }
}
