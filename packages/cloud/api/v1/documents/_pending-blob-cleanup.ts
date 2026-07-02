import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const DELETE_RETRY_DELAYS_MS = [100, 250] as const;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function deletePendingDocumentBlob(
  bucket: AppEnv["Bindings"]["BLOB"],
  key: string,
): Promise<void> {
  let lastError: unknown;
  for (
    let attempt = 1;
    attempt <= DELETE_RETRY_DELAYS_MS.length + 1;
    attempt++
  ) {
    try {
      await bucket.delete(key);
      return;
    } catch (error) {
      lastError = error;
      const nextDelay = DELETE_RETRY_DELAYS_MS[attempt - 1];
      if (nextDelay === undefined) break;
      logger.warn("[Documents] Pending blob delete failed; retrying", {
        key,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
      await delay(nextDelay);
    }
  }

  throw lastError;
}
