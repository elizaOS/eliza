/**
 * Desktop Steward sidecar — implemented in `@elizaos/app-steward`.
 * Re-exported here so consumers can import from `@elizaos/app-core` only.
 */
export {
  createDesktopStewardSidecar,
  type StewardCredentials,
  StewardSidecar,
  type StewardSidecarConfig,
  type StewardSidecarStatus,
  type StewardWalletInfo,
} from "@elizaos/app-steward/services/steward-sidecar";
