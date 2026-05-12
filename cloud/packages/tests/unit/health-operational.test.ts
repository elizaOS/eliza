/**
 * Tests for the operational health endpoint.
 *
 * `/api/health/operational` returns the subsystem-config booleans that
 * monitoring needs to alert on. The endpoint must:
 *  - Stay unauthed (monitors don't carry creds).
 *  - Never emit balances, addresses, or secret material.
 *  - Flip `status` to `degraded` when ANY required-for-production check
 *    fails so a single boolean grep is enough for alerting.
 *
 * Tests configure the endpoint via `process.env` directly instead of
 * `mock.module(...)` — `getCloudAwareEnv()` reads from `process.env` by
 * default (no ALS store in unit tests), and module mocks in `bun:test`
 * leak across files in the same run.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Hono } from "hono";

const ENV_KEYS = [
  "STEWARD_PLATFORM_KEYS",
  "EVM_PAYOUT_PRIVATE_KEY",
  "EVM_PRIVATE_KEY",
  "EVM_PAYOUT_WALLET_ADDRESS",
  "SOLANA_PAYOUT_PRIVATE_KEY",
  "CRON_SECRET",
] as const;

const originalEnv = new Map<string, string | undefined>();

async function importHealthOperationalApp(): Promise<Hono> {
  const { Hono: HonoCtor } = await import("hono");
  const url = new URL(
    `../../../apps/api/health/operational/route.ts?test=${Date.now()}-${Math.random()}`,
    import.meta.url,
  );
  const mod = (await import(url.href)) as { default: Hono };
  const parent = new HonoCtor();
  parent.route("/api/health/operational", mod.default);
  return parent as Hono;
}

async function fetchHealth() {
  const app = await importHealthOperationalApp();
  const res = await app.fetch(new Request("http://test.local/api/health/operational"));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function clearTestEnv() {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

describe("/api/health/operational", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
    }
    clearTestEnv();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const v = originalEnv.get(key);
      if (v === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = v;
      }
    }
  });

  test("all configured → status=ok, all checks pass", async () => {
    process.env.STEWARD_PLATFORM_KEYS = "platform-key-1";
    process.env.EVM_PAYOUT_PRIVATE_KEY = "0x" + "a".repeat(64);
    process.env.SOLANA_PAYOUT_PRIVATE_KEY = "solana-key";
    process.env.CRON_SECRET = "cron-secret";

    const { status, body } = await fetchHealth();

    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    const checks = body.checks as Record<string, { configured?: boolean; evm_configured?: boolean; solana_configured?: boolean }>;
    expect(checks.steward_platform.configured).toBe(true);
    expect(checks.payouts.evm_configured).toBe(true);
    expect(checks.payouts.solana_configured).toBe(true);
    expect(checks.crons.configured).toBe(true);
  });

  test("missing STEWARD_PLATFORM_KEYS → status=degraded with steward message", async () => {
    process.env.EVM_PAYOUT_PRIVATE_KEY = "0x" + "a".repeat(64);
    process.env.CRON_SECRET = "cron-secret";

    const { body } = await fetchHealth();

    expect(body.status).toBe("degraded");
    const checks = body.checks as Record<string, { configured: boolean; message: string }>;
    expect(checks.steward_platform.configured).toBe(false);
    expect(checks.steward_platform.message).toContain("STEWARD_PLATFORM_KEYS");
  });

  test("missing CRON_SECRET → status=degraded with crons message", async () => {
    process.env.STEWARD_PLATFORM_KEYS = "platform-key-1";
    process.env.EVM_PAYOUT_PRIVATE_KEY = "0x" + "a".repeat(64);

    const { body } = await fetchHealth();

    expect(body.status).toBe("degraded");
    const checks = body.checks as Record<string, { configured: boolean; message: string }>;
    expect(checks.crons.configured).toBe(false);
    expect(checks.crons.message).toContain("CRON_SECRET");
  });

  test("no payout wallets → status=degraded with payouts message", async () => {
    process.env.STEWARD_PLATFORM_KEYS = "platform-key-1";
    process.env.CRON_SECRET = "cron-secret";

    const { body } = await fetchHealth();

    expect(body.status).toBe("degraded");
    const checks = body.checks as Record<string, { evm_configured: boolean; solana_configured: boolean; message: string }>;
    expect(checks.payouts.evm_configured).toBe(false);
    expect(checks.payouts.solana_configured).toBe(false);
    expect(checks.payouts.message).toContain("No payout wallets");
  });

  test("only Solana payouts configured → still ok (one chain is enough)", async () => {
    process.env.STEWARD_PLATFORM_KEYS = "platform-key-1";
    process.env.SOLANA_PAYOUT_PRIVATE_KEY = "solana-key";
    process.env.CRON_SECRET = "cron-secret";

    const { body } = await fetchHealth();

    expect(body.status).toBe("ok");
    const checks = body.checks as Record<string, { evm_configured: boolean; solana_configured: boolean }>;
    expect(checks.payouts.evm_configured).toBe(false);
    expect(checks.payouts.solana_configured).toBe(true);
  });

  test("response does not leak balances, addresses, or secret material", async () => {
    process.env.STEWARD_PLATFORM_KEYS = "supersecret-platform-key";
    process.env.EVM_PAYOUT_PRIVATE_KEY = "0xdeadbeef";
    process.env.SOLANA_PAYOUT_PRIVATE_KEY = "secret-sol-key";
    process.env.CRON_SECRET = "supersecret-cron";

    const { body } = await fetchHealth();
    const serialized = JSON.stringify(body);

    expect(serialized).not.toContain("supersecret-platform-key");
    expect(serialized).not.toContain("0xdeadbeef");
    expect(serialized).not.toContain("secret-sol-key");
    expect(serialized).not.toContain("supersecret-cron");
    expect(serialized.match(/"balance"\s*:/)).toBeNull();
  });
});
