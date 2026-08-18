/**
 * Seals the warm-child authenticator before the ACP module graph can observe
 * process credentials, while preserving boot-time PATH capture for cold ACP
 * children. Warm children capture PATH only after their authenticated session
 * claim installs the per-session Git wrapper.
 */
import { captureHostExecutionBaseline } from "@elizaos/shared/host-execution-env";

let warmClaimToken = process.env.ELIZA_ACP_WARM_CLAIM_TOKEN?.trim() ?? "";
delete process.env.ELIZA_ACP_WARM_CLAIM_TOKEN;

if (!warmClaimToken) captureHostExecutionBaseline();

export function consumeWarmClaimToken(): string {
  const token = warmClaimToken;
  warmClaimToken = "";
  return token;
}
