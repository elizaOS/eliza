import type { IAgentRuntime } from "@elizaos/core";
import { PublicKey } from "@solana/web3.js";
import type { Account, Hex, TypedDataDefinition } from "viem";
import { hexToBytes } from "viem";
import type { WalletAddresses, WalletBackend } from "./backend.js";
import { StewardUnavailableError } from "./errors.js";
import type { SignResult, SignScope } from "./pending.js";

/**
 * Structural stand-in for viem `Account` produced by Steward — avoids incompatible
 * nominal `Account` types when multiple `viem` copies resolve in the workspace.
 */
interface StewardEvmAccountBinding {
  readonly address: `0x${string}`;
  signMessage?(parameters: {
    message: string | { raw: Uint8Array | string };
  }): Promise<Hex>;
  signTypedData?(typedData: TypedDataDefinition): Promise<Hex>;
}

/**
 * Shape of the dynamically imported @elizaos/app-steward/services/steward-evm-account
 * module. Defined locally to avoid a devDependency cycle with app-steward.
 */
interface StewardEvmAccountModule {
  initStewardEvmAccount(): Promise<StewardEvmAccountBinding | null>;
  resolveStewardEvmConfig(): {
    apiUrl: string;
    agentToken: string;
    agentId: string;
  } | null;
  fetchStewardVaultChainAddresses(
    apiUrl: string,
    agentToken: string,
    agentId: string,
  ): Promise<{ evm: `0x${string}` | null; solana: string | null }>;
}

/**
 * Cloud / mobile signing via Steward for EVM. Solana addresses may be exposed from
 * Steward when `/vault/.../addresses` returns them; Solana **transaction** signing is
 * not implemented here yet — callers must treat Solana writes as unavailable until wired.
 */
export class StewardBackend implements WalletBackend {
  readonly kind = "steward" as const;

  private readonly account: StewardEvmAccountBinding;

  private readonly solanaPubkey: PublicKey | null;

  private constructor(
    account: StewardEvmAccountBinding,
    solanaPubkey: PublicKey | null,
  ) {
    this.account = account;
    this.solanaPubkey = solanaPubkey;
  }

  static async create(_runtime: IAgentRuntime): Promise<StewardBackend> {
    void _runtime;
    let steward: StewardEvmAccountModule;
    try {
      steward = await import("@elizaos/app-steward");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new StewardUnavailableError(
        `Cannot load Steward wallet module (@elizaos/app-steward): ${detail}`,
      );
    }

    const account = await steward.initStewardEvmAccount();
    if (!account) {
      throw new StewardUnavailableError(
        "Steward EVM account initialization failed. Set STEWARD_API_URL, STEWARD_AGENT_TOKEN, and STEWARD_AGENT_ID (or a JWT whose payload contains agentId/sub).",
      );
    }

    const cfg = steward.resolveStewardEvmConfig();
    if (!cfg) {
      throw new StewardUnavailableError(
        "Steward env configuration resolved to null after account init.",
      );
    }

    const chains = await steward.fetchStewardVaultChainAddresses(
      cfg.apiUrl,
      cfg.agentToken,
      cfg.agentId,
    );

    let solanaPubkey: PublicKey | null = null;
    if (chains.solana) {
      try {
        solanaPubkey = new PublicKey(chains.solana);
      } catch {
        solanaPubkey = null;
      }
    }

    return new StewardBackend(
      account as StewardEvmAccountBinding,
      solanaPubkey,
    );
  }

  getAddresses(): WalletAddresses {
    return {
      evm: this.account.address as WalletAddresses["evm"],
      solana: this.solanaPubkey,
    };
  }

  canSign(chainHint: "evm" | "solana" | "off-chain"): boolean {
    if (chainHint === "solana") {
      return false;
    }
    return true;
  }

  getEvmAccount(_chainId: number): Account {
    void _chainId;
    return this.account as Account;
  }

  getSolanaSigner(): never {
    throw new StewardUnavailableError(
      "Solana transaction signing via Steward is not implemented in this runtime yet.",
    );
  }

  async signMessage(scope: SignScope, message: Hex): Promise<SignResult> {
    void scope;
    const signMessage = this.account.signMessage?.bind(this.account);
    if (!signMessage) {
      throw new StewardUnavailableError(
        "Steward EVM account does not expose signMessage.",
      );
    }
    const sig = await signMessage({
      message: { raw: hexToBytes(message) },
    });
    return { kind: "signature", signature: sig };
  }

  async signTypedData(
    scope: SignScope,
    typedData: TypedDataDefinition,
  ): Promise<SignResult> {
    void scope;
    const signTypedData = this.account.signTypedData?.bind(this.account);
    if (!signTypedData) {
      throw new StewardUnavailableError(
        "Steward EVM account does not expose signTypedData.",
      );
    }
    const sig = await signTypedData(typedData);
    return { kind: "signature", signature: sig };
  }
}
