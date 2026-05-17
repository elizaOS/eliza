/**
 * Steward Sidecar - first-launch wallet creation and verification.
 */
import type { StewardCredentials, StewardSidecarStatus } from "./types";
/**
 * Ensure wallet is set up: verify existing wallet or perform first-launch setup.
 */
export declare function ensureWalletSetup(
  credentials: StewardCredentials | null,
  apiBase: string,
  masterPassword: string | undefined,
  dataDir: string,
  updateStatus: (partial: Partial<StewardSidecarStatus>) => void,
): Promise<StewardCredentials>;
//# sourceMappingURL=wallet-setup.d.ts.map
