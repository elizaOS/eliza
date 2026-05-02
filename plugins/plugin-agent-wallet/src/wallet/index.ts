export type {
	WalletBackend,
	WalletAddresses,
	WalletBackendKind,
	SolanaSigner,
} from "./backend.js";
export type {
	SignScope,
	ApprovalSummary,
	PendingApproval,
	SignaturePayload,
	SignResult,
	ValidateOutcome,
	CanonicalHandlerResult,
} from "./pending.js";
export {
	WalletBackendNotConfiguredError,
	StewardUnavailableError,
	PendingApprovalError,
	SolanaPrivateKeyInvalidError,
} from "./errors.js";
export { LocalEoaBackend } from "./local-eoa-backend.js";
export { StewardBackend } from "./steward-backend.js";
export { resolveWalletBackend, type WalletBackendMode } from "./select-backend.js";
