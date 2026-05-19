import type { PendingApproval } from "./pending.js";

export type WalletBackendNotConfiguredCode =
  | "EVM_PRIVATE_KEY_MISSING"
  | "SOLANA_PRIVATE_KEY_MISSING"
  | "NO_WALLET_CONFIGURED";

export class WalletBackendNotConfiguredError extends Error {
  readonly code: WalletBackendNotConfiguredCode;

  constructor(code: WalletBackendNotConfiguredCode, message?: string) {
    const defaults: Record<WalletBackendNotConfiguredCode, string> = {
      EVM_PRIVATE_KEY_MISSING:
        "EVM private key is not configured. Set EVM_PRIVATE_KEY (or hydrate from the OS keychain) before using EVM wallet actions.",
      SOLANA_PRIVATE_KEY_MISSING:
        "Solana private key is not configured. Set SOLANA_PRIVATE_KEY (base58; or hydrate from the OS keychain) before using Solana wallet actions.",
      NO_WALLET_CONFIGURED:
        "No wallet keys are configured. Set at least EVM_PRIVATE_KEY and/or SOLANA_PRIVATE_KEY (local), or use Steward (cloud).",
    };
    super(message ?? defaults[code]);
    this.name = "WalletBackendNotConfiguredError";
    this.code = code;
  }
}

export class StewardUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StewardUnavailableError";
  }
}

export class PendingApprovalError extends Error {
  readonly kind = "pending_approval" as const;

  constructor(readonly pending: PendingApproval) {
    super(
      `Wallet operation pending approval: ${pending.scope} (${pending.approvalId})`,
    );
    this.name = "PendingApprovalError";
  }
}

export class SolanaPrivateKeyInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolanaPrivateKeyInvalidError";
  }
}
