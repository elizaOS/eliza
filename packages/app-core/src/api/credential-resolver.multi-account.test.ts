/**
 * Real-path multi-account credential resolution — issue #10696.
 *
 * The sibling `services/multi-account-rotation.test.ts` proves the *coding*
 * subscription path (Claude Code / Codex) selects across two accounts. This
 * proves the *direct-API* path: `resolveProviderCredentialMulti` — the resolver
 * the runtime uses to hand a provider plugin its real API key — genuinely serves
 * the top-priority account's OWN stored token, honors priority reordering,
 * fails over on rate-limit, respects an `exclude` set, never bleeds one
 * account's token to another, and falls back to the env var when the pool is
 * empty.
 *
 * It drives the REAL resolver over a REAL on-disk credential store (throwaway
 * `ELIZA_HOME`) — same harness shape as `multi-account-rotation.test.ts`
 * (`writeAccount` / `setMeta` / `__resetDefaultAccountPoolForTests`). The only
 * synthetic element is the token *string*; the store, the pool, the priority
 * overlay round-trip, and `getAccessToken`'s credential read are the production
 * code path. Runs in CI with no secrets.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveAccount } from "@elizaos/auth/account-storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetDefaultAccountPoolForTests,
  getDefaultAccountPool,
} from "../account-pool.js";
import { resolveProviderCredentialMulti } from "./credential-resolver.js";

const PROVIDER = "anthropic-api";
const FAR_FUTURE = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
let home: string;
let prevHome: string | undefined;
let prevStateDir: string | undefined;
let prevAnthropicKey: string | undefined;

/** Write a real direct-API credential record to the on-disk store. */
function writeAccount(
  id: string,
  access: string,
  extra: { createdAt?: number } = {},
): void {
  saveAccount({
    id,
    providerId: PROVIDER,
    label: id,
    source: "api-key",
    credentials: {
      access,
      refresh: "",
      expires: FAR_FUTURE,
    },
    createdAt: extra.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  });
}

/** Mutate the pool-metadata overlay (priority/enabled) the way the HTTP PATCH route does. */
async function setMeta(
  id: string,
  patch: { priority?: number; enabled?: boolean },
): Promise<void> {
  const pool = getDefaultAccountPool();
  const account = pool.list(PROVIDER).find((a) => a.id === id);
  if (!account) throw new Error(`no account ${id}`);
  await pool.upsert({ ...account, ...patch });
}

beforeEach(() => {
  prevHome = process.env.ELIZA_HOME;
  prevStateDir = process.env.ELIZA_STATE_DIR;
  prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
  home = mkdtempSync(path.join(tmpdir(), "cred-resolver-multi-"));
  process.env.ELIZA_HOME = home;
  process.env.ELIZA_STATE_DIR = home;
  // A stray real key would mask the env-fallback vs pool distinction — clear it.
  delete process.env.ANTHROPIC_API_KEY;
  __resetDefaultAccountPoolForTests();
});

afterEach(() => {
  __resetDefaultAccountPoolForTests();
  if (prevHome === undefined) delete process.env.ELIZA_HOME;
  else process.env.ELIZA_HOME = prevHome;
  if (prevStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = prevStateDir;
  if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
  rmSync(home, { recursive: true, force: true });
});

describe("resolveProviderCredentialMulti direct-API multi-account (#10696)", () => {
  it("priority serves the top-priority account's OWN stored access token", async () => {
    writeAccount("primary", "sk-ant-api-PRIMARY", { createdAt: 1_000 });
    writeAccount("secondary", "sk-ant-api-SECONDARY", { createdAt: 2_000 });
    getDefaultAccountPool();
    await setMeta("primary", { priority: 0 });
    await setMeta("secondary", { priority: 1 });

    // "anthropic" (short name) maps to the "anthropic-api" direct provider.
    const resolved = await resolveProviderCredentialMulti("anthropic");
    expect(resolved).toEqual({
      providerId: "anthropic",
      envVar: "ANTHROPIC_API_KEY",
      apiKey: "sk-ant-api-PRIMARY",
      authType: "api-key",
    });
  });

  it("reordering priority flips which account's token is served", async () => {
    writeAccount("primary", "sk-ant-api-PRIMARY", { createdAt: 1_000 });
    writeAccount("secondary", "sk-ant-api-SECONDARY", { createdAt: 2_000 });
    getDefaultAccountPool();
    await setMeta("primary", { priority: 0 });
    await setMeta("secondary", { priority: 1 });

    expect((await resolveProviderCredentialMulti("anthropic"))?.apiKey).toBe(
      "sk-ant-api-PRIMARY",
    );

    // Operator drags "secondary" above "primary" (PATCH priority).
    await setMeta("primary", { priority: 1 });
    await setMeta("secondary", { priority: 0 });

    expect((await resolveProviderCredentialMulti("anthropic"))?.apiKey).toBe(
      "sk-ant-api-SECONDARY",
    );
  });

  it("rate-limiting the top account fails over to the sibling — no dropped request", async () => {
    writeAccount("primary", "sk-ant-api-PRIMARY", { createdAt: 1_000 });
    writeAccount("secondary", "sk-ant-api-SECONDARY", { createdAt: 2_000 });
    const pool = getDefaultAccountPool();
    await setMeta("primary", { priority: 0 });
    await setMeta("secondary", { priority: 1 });

    expect((await resolveProviderCredentialMulti("anthropic"))?.apiKey).toBe(
      "sk-ant-api-PRIMARY",
    );

    await pool.markRateLimited("primary", Date.now() + 60 * 60 * 1000, "429", {
      providerId: PROVIDER,
    });

    const failover = await resolveProviderCredentialMulti("anthropic");
    expect(failover?.apiKey).toBe("sk-ant-api-SECONDARY");
    expect(pool.list(PROVIDER).find((a) => a.id === "primary")?.health).toBe(
      "rate-limited",
    );
  });

  it("an excluded account is skipped in favor of the next", async () => {
    writeAccount("primary", "sk-ant-api-PRIMARY", { createdAt: 1_000 });
    writeAccount("secondary", "sk-ant-api-SECONDARY", { createdAt: 2_000 });
    getDefaultAccountPool();
    await setMeta("primary", { priority: 0 });
    await setMeta("secondary", { priority: 1 });

    const resolved = await resolveProviderCredentialMulti("anthropic", {
      exclude: ["primary"],
    });
    expect(resolved?.apiKey).toBe("sk-ant-api-SECONDARY");
  });

  it("no token bleed: each account serves only its own stored token", async () => {
    writeAccount("primary", "sk-ant-api-PRIMARY", { createdAt: 1_000 });
    writeAccount("secondary", "sk-ant-api-SECONDARY", { createdAt: 2_000 });
    getDefaultAccountPool();
    await setMeta("primary", { priority: 0 });
    await setMeta("secondary", { priority: 1 });

    const first = await resolveProviderCredentialMulti("anthropic");
    const second = await resolveProviderCredentialMulti("anthropic", {
      exclude: ["primary"],
    });
    expect(first?.apiKey).toBe("sk-ant-api-PRIMARY");
    expect(second?.apiKey).toBe("sk-ant-api-SECONDARY");
    expect(first?.apiKey).not.toBe(second?.apiKey);
  });

  it("falls back to the env var when the account pool is empty", async () => {
    // No accounts on disk → the direct-provider branch finds none and defers.
    process.env.ANTHROPIC_API_KEY = "sk-ant-env-FALLBACK";
    getDefaultAccountPool();

    const resolved = await resolveProviderCredentialMulti("anthropic");
    expect(resolved).toEqual({
      providerId: "anthropic",
      envVar: "ANTHROPIC_API_KEY",
      apiKey: "sk-ant-env-FALLBACK",
      authType: "api-key",
    });
  });
});
