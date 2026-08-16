/**
 * Establishes the canonical Worker request context for authenticated Personal
 * Telegram edge turns without adding database modules to webhook cold start.
 */

import type { AppContext } from "@/types/cloud-worker-env";

export async function runPersonalTelegramRequestScope<T>(
  c: AppContext,
  idempotencyKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  const [
    { runWithDbCacheAsync },
    { getRequestIp },
    { runWithCloudBindingsAsync },
    { runWithRequestContext },
    { setRuntimeR2Bucket },
  ] = await Promise.all([
    import("@/db/client"),
    import("@/lib/middleware/rate-limit-hono-cloudflare"),
    import("@/lib/runtime/cloud-bindings"),
    import("@/lib/runtime/request-context"),
    import("@/lib/storage/r2-runtime-binding"),
  ]);

  setRuntimeR2Bucket(c.env.BLOB);
  return runWithCloudBindingsAsync(c.env as Record<string, unknown>, async () =>
    runWithRequestContext(
      {
        clientIp: getRequestIp(c),
        idempotencyKey,
      },
      async () => runWithDbCacheAsync(operation),
    ),
  );
}
