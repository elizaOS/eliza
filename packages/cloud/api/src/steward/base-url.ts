/** Resolves configured Steward upstreams for direct authentication calls. */

import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";

export function resolveStewardBaseUrl(env: AppEnv["Bindings"]): string | null {
  const candidates: Array<[string, string | undefined]> = [
    ["STEWARD_API_URL", env.STEWARD_API_URL],
    ["NEXT_PUBLIC_STEWARD_API_URL", env.NEXT_PUBLIC_STEWARD_API_URL],
  ];
  for (const [key, candidate] of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim().replace(/\/+$/, "");
    if (trimmed.length === 0) continue;
    try {
      const url = new URL(trimmed);
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      return trimmed;
    } catch (error) {
      // A non-empty candidate that fails to parse is a misconfiguration, not a
      // missing value. Name the env var so the resulting 503 is debuggable; never
      // log the value itself (it may contain credentials).
      logger.warn("[StewardAuth] Ignoring unparseable Steward base URL", {
        envVar: key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return null;
}
