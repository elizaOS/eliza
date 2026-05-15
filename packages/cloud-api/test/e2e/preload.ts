/**
 * Worker-targeted e2e preload.
 *
 * The Worker e2e files skip cleanly when no Worker is listening. CI uses this
 * as a syntax/import smoke for the route tests before deploying the Worker;
 * local and staging runs can opt into hard failures with REQUIRE_E2E_SERVER=1.
 */

import { resolve } from "node:path";
import { config } from "dotenv";

for (const envPath of [
  resolve(".env"),
  resolve(".env.local"),
  resolve(".env.test"),
]) {
  config({ path: envPath });
}

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
  throw new Error(
    "Worker e2e requires a bootstrapped test database; unset SKIP_DB_DEPENDENT.",
  );
}

if (!process.env.TEST_API_KEY?.trim()) {
  console.warn(
    "[worker-e2e] TEST_API_KEY is not set; auth-gated Worker e2e tests will skip.",
  );
}

if (
  process.env.REQUIRE_E2E_SERVER === "1" ||
  process.env.REQUIRE_E2E_SERVER === "true"
) {
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
