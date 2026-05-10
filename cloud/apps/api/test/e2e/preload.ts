/**
 * Worker-targeted e2e preload.
 *
 * Mirrors `cloud/packages/tests/e2e/preload.ts` but does NOT boot the legacy
 * Next.js dev server — the Worker-targeted suite expects an already-running
 * Worker (typically `wrangler dev` on :8787) and just needs:
 *
 *   1. Env loaded from .env / .env.local / .env.test.
 *   2. Local Postgres seeded with the test org/user/api-key, which exports
 *      TEST_API_KEY into process.env.
 *
 * Run with: bun test --preload <this-file> apps/api/test/e2e
 */

import "../../../../packages/tests/load-env";
import { ensureLocalTestAuth } from "../../../../packages/tests/infrastructure/local-test-auth";

const DEFAULT_TEST_SECRETS_MASTER_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

if (!process.env.SECRETS_MASTER_KEY) {
  process.env.SECRETS_MASTER_KEY = DEFAULT_TEST_SECRETS_MASTER_KEY;
}

process.env.CRON_SECRET ??= "test-cron-secret";
process.env.INTERNAL_SECRET ??= "test-internal-secret";
process.env.AGENT_TEST_BOOTSTRAP_ADMIN ??= "true";
process.env.PLAYWRIGHT_TEST_AUTH ??= "true";
process.env.PLAYWRIGHT_TEST_AUTH_SECRET ??= "playwright-local-auth-secret";
process.env.PAYOUT_STATUS_SKIP_LIVE_BALANCE ??= "1";

if (process.env.SKIP_DB_DEPENDENT === "1") {
  throw new Error("Worker e2e requires a bootstrapped test database; unset SKIP_DB_DEPENDENT.");
}

await ensureLocalTestAuth();

if (process.env.REQUIRE_E2E_SERVER !== "0") {
  const baseUrl =
    process.env.TEST_API_BASE_URL?.trim() ||
    process.env.TEST_BASE_URL?.trim() ||
    "http://localhost:8787";
  const response = await fetch(`${baseUrl}/api/health`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(
      `Worker e2e target is not healthy: GET ${baseUrl}/api/health -> ${response.status}`,
    );
  }
}
