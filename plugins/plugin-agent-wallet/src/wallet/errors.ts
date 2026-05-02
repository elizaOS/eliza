import type { PendingApproval } from "./pending.js";

export class WalletBackendNotConfiguredError extends Error {
	readonly code: "EVM_PRIVATE_KEY_MISSING" | "SOLANA_PRIVATE_KEY_MISSING";

	constructor(
		code: "EVM_PRIVATE_KEY_MISSING" | "SOLANA_PRIVATE_KEY_MISSING",
		message?: string,
	) {
		super(
			message ??
				(code === "EVM_PRIVATE_KEY_MISSING"
					? "EVM private key is not configured. Set EVM_PRIVATE_KEY (or hydrate from the OS keychain) before using wallet actions."
					: "Solana private key is not configured. Set SOLANA_PRIVATE_KEY (base58; or hydrate from the OS keychain) before using wallet actions."),
		);
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
