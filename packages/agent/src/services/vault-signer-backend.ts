/**
 * Vault-backed EVM signer. Implements `SignerBackend` over the per-agent
 * EVM key stored in the Eliza vault (`agent.<id>.wallet.evm`).
 *
 * The private key is revealed from the vault on demand and used to build an
 * ethers `Wallet` purely to produce a signature; it is never written to env,
 * logged, or returned. `revealAgentWalletPrivateKey` is itself fail-closed
 * under a blocking TEE boot gate, so this backend inherits that guard.
 *
 * EVM only: Solana signing would require `@solana/web3.js`, which the
 * agent-wallet layer deliberately avoids pulling in. A Solana backend can be
 * added separately when that dependency is acceptable.
 */

import type { Vault } from "@elizaos/vault";
import { ethers } from "ethers";
import { revealAgentWalletPrivateKey } from "../runtime/agent-wallets.ts";
import type {
  SignerBackend,
  UnsignedTransaction,
} from "./remote-signing-service.ts";

export interface VaultSignerBackendConfig {
  readonly vault: Vault;
  readonly agentId: string;
  /** Audit caller tag forwarded to `vault.reveal`. */
  readonly caller?: string;
}

export class VaultSignerBackend implements SignerBackend {
  private readonly vault: Vault;
  private readonly agentId: string;
  private readonly caller: string;

  constructor(config: VaultSignerBackendConfig) {
    if (config.agentId.trim().length === 0) {
      throw new TypeError("VaultSignerBackend: agentId must be non-empty");
    }
    this.vault = config.vault;
    this.agentId = config.agentId;
    this.caller = config.caller ?? "remote-signing:vault-signer";
  }

  async getAddress(): Promise<string> {
    return (await this.wallet()).address;
  }

  async signMessage(message: string): Promise<string> {
    return (await this.wallet()).signMessage(message);
  }

  async signTransaction(tx: UnsignedTransaction): Promise<string> {
    const wallet = await this.wallet();
    const request: ethers.TransactionRequest = {
      to: tx.to,
      value: tx.value,
      data: tx.data,
      chainId: tx.chainId,
    };
    if (tx.nonce !== undefined) request.nonce = tx.nonce;
    if (tx.gasLimit !== undefined) request.gasLimit = tx.gasLimit;
    if (tx.maxFeePerGas !== undefined) request.maxFeePerGas = tx.maxFeePerGas;
    if (tx.maxPriorityFeePerGas !== undefined) {
      request.maxPriorityFeePerGas = tx.maxPriorityFeePerGas;
    }
    return wallet.signTransaction(request);
  }

  private async wallet(): Promise<ethers.Wallet> {
    const privateKey = await revealAgentWalletPrivateKey(
      this.vault,
      this.agentId,
      "evm",
      this.caller,
    );
    return new ethers.Wallet(privateKey);
  }
}
