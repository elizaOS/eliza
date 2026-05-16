/**
 * Build the env block passed to cloud-api / cloud-frontend subprocesses.
 *
 * Centralizes test flags (PLAYWRIGHT_TEST_AUTH, MOCK_REDIS, mock URLs, etc.)
 * so the rest of the fixture code stays focused on lifecycle.
 */

export interface StackUrls {
  hetzner: string;
  controlPlane: string;
  pgliteHost: string;
  pglitePort: number;
}

export const PLAYWRIGHT_TEST_AUTH_SECRET = "playwright-local-auth-secret-32bytes";

export function buildSharedEnv(
  urls: StackUrls,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: "test",
    // Mocks
    MOCK_REDIS: "1",
    MOCK_HETZNER_LATENCY: "0",
    MOCK_HETZNER_ACTION_MS: process.env.MOCK_HETZNER_ACTION_MS ?? "30",
    CONTROL_PLANE_TICK_MS: process.env.CONTROL_PLANE_TICK_MS ?? "50",
    HCLOUD_API_BASE_URL: urls.hetzner,
    HCLOUD_TOKEN: "test-token",
    CONTAINER_CONTROL_PLANE_URL: urls.controlPlane,
    CONTAINER_CONTROL_PLANE_TOKEN: "test-token",
    CRON_SECRET: "test-cron-secret",
    INTERNAL_SECRET: "test-internal-secret",
    // Playwright test auth bypass — secret read by cloud-shared auth helpers
    PLAYWRIGHT_TEST_AUTH: "true",
    PLAYWRIGHT_TEST_AUTH_SECRET: PLAYWRIGHT_TEST_AUTH_SECRET,
    NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH: "true",
    VITE_PLAYWRIGHT_TEST_AUTH: "true",
    // PGlite via TCP bridge (cloud-api-dev.mjs handles this)
    DATABASE_URL: `postgresql://postgres@${urls.pgliteHost}:${urls.pglitePort}/postgres`,
    TEST_DATABASE_URL: `postgresql://postgres@${urls.pgliteHost}:${urls.pglitePort}/postgres`,
    PGLITE_HOST: urls.pgliteHost,
    PGLITE_PORT: String(urls.pglitePort),
    // Defaults required by various cloud-shared subsystems
    SECRETS_MASTER_KEY:
      process.env.SECRETS_MASTER_KEY ??
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    PAYOUT_STATUS_SKIP_LIVE_BALANCE: "1",
    AGENT_TEST_BOOTSTRAP_ADMIN: "true",
    ...extra,
  };
}
