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

export const PLAYWRIGHT_TEST_AUTH_SECRET =
  "playwright-local-auth-secret-32bytes";

/**
 * Strip env vars that announce the current process was launched via bun
 * (npm_execpath, BUN_INSTALL_BIN, _ etc). Wrangler auto-detects its
 * "packageManager" from these and refuses to start under the bun runtime,
 * even when we spawn it via `node` / `npx`.
 */
function stripBunAncestryEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = { ...env };
  const keysToDrop = [
    "npm_execpath",
    "npm_lifecycle_event",
    "npm_lifecycle_script",
    "npm_command",
    "npm_node_execpath",
    "npm_config_user_agent",
    "BUN_INSTALL_BIN",
    "_",
  ];
  for (const key of keysToDrop) delete cleaned[key];
  return cleaned;
}

export function buildSharedEnv(
  urls: StackUrls,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    ...stripBunAncestryEnv(process.env),
    NODE_ENV: "test",
    CLOUD_E2E: "1",
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
    // Stub the Cloudflare registrar/DNS so domain check/buy routes never hit
    // the real Cloudflare API (the registrar reads this via getCloudAwareEnv).
    // The fixture spawns cloud-api-e2e-server.mjs directly, so it doesn't get
    // the `--var` injection cloud-api-dev.mjs does — set it here instead.
    ELIZA_CF_REGISTRAR_DEV_STUB: process.env.ELIZA_CF_REGISTRAR_DEV_STUB ?? "1",
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
    // Treat the (dummy, configured) payout wallet as operational so the
    // redemption quote/request flow is exercisable without a funded wallet or
    // live RPC. The on-chain transfer cron still verifies the real balance.
    PAYOUT_STATUS_ASSUME_OPERATIONAL: "1",
    // Dummy EVM payout key so the EVM redemption networks (base/bnb/ethereum)
    // report "operational" for the redemption availability gate. Paired with
    // PAYOUT_STATUS_SKIP_LIVE_BALANCE=1 there is NO real RPC/balance call; the
    // actual on-chain transfer only runs in the process-redemptions cron, which
    // the e2e never invokes. Test-only, never a real funded wallet.
    EVM_PAYOUT_PRIVATE_KEY:
      process.env.EVM_PAYOUT_PRIVATE_KEY ??
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    AGENT_TEST_BOOTSTRAP_ADMIN: "true",
    ...extra,
  };
}
