/** Barrel for the `WalletBackend` abstraction: the signer interface, its local/Steward implementations, error types, and pending-approval/sign-result types. */
export type {
  SolanaSigner,
  WalletAddresses,
  WalletBackend,
  WalletBackendKind,
} from "./backend.js";
export {
  PendingApprovalError,
  SolanaPrivateKeyInvalidError,
  StewardUnavailableError,
  WalletBackendNotConfiguredError,
} from "./errors.js";
export { LocalEoaBackend } from "./local-eoa-backend.js";
export type {
  ApprovalSummary,
  CanonicalHandlerResult,
  PendingApproval,
  SignaturePayload,
  SignResult,
  SignScope,
  ValidateOutcome,
} from "./pending.js";
export {
  resolveWalletBackend,
  type WalletBackendMode,
} from "./select-backend.js";
export { StewardBackend } from "./steward-backend.js";
