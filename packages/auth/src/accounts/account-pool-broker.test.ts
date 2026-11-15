import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// The default pool and the credential helpers read through a runtime storage
// policy, which resolves the vault master key. Inject one in-memory test key
// for that, and write this file's fixtures through the same runtime policy.
vi.mock("../vault/master-key.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../vault/master-key.js")>();
  const { randomBytes } = await import("node:crypto");
  const testKey = randomBytes(32);
  return { ...actual, loadDefaultMasterKeySync: () => Buffer.from(testKey) };
});
vi.mock("../auth/account-storage.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../auth/account-storage.js")>();
  return {
    ...actual,
    createIsolatedAccountStoragePolicy:
      actual.createRuntimeAccountStoragePolicy,
  };
});

import {
  createIsolatedAccountStoragePolicy,
  deleteAccount,
  saveAccount,
} from "../auth/account-storage.js";
import {
  type AccountPoolDeps,
  getDefaultAccountPool,
  resetDefaultAccountPoolAfterCredentialReset,
} from "./account-pool.js";
import {
  AccountPoolBroker,
  resolveBrokerAccessToken,
} from "./account-pool-broker.js";

const providerId = "openai-codex";
let home: string;
let previousHome: string | undefined;
let previousState: string | undefined;
function save(access: string, organizationId = access): void {
  saveAccount(
    {
      id: "broker-account",
      providerId,
      label: access,
      source: "oauth",
      organizationId,
      credentials: {
        access,
        refresh: `${access}-refresh`,
        expires: Date.now() + 10 * 365 * 86_400_000,
      },
      createdAt: 1,
      updatedAt: Date.now(),
    },
    createIsolatedAccountStoragePolicy(home),
  );
}
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
beforeEach(() => {
  previousHome = process.env.ELIZA_HOME;
  previousState = process.env.ELIZA_STATE_DIR;
  home = mkdtempSync(path.join(tmpdir(), "broker-state-"));
  process.env.ELIZA_HOME = home;
  process.env.ELIZA_STATE_DIR = home;
  resetDefaultAccountPoolAfterCredentialReset();
  save("original");
});
afterEach(() => {
  vi.restoreAllMocks();
  resetDefaultAccountPoolAfterCredentialReset();
  if (previousHome === undefined) delete process.env.ELIZA_HOME;
  else process.env.ELIZA_HOME = previousHome;
  if (previousState === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = previousState;
  rmSync(home, { recursive: true, force: true });
});
it.each([401, 429])(
  "fences a replaced credential from an old broker %i report",
  async (httpStatus) => {
    const pool = getDefaultAccountPool();
    const broker = new AccountPoolBroker({ pool });
    const lease = await broker.lease({ providerId, sessionKey: "session" });
    assert(lease);
    deleteAccount(
      providerId,
      "broker-account",
      createIsolatedAccountStoragePolicy(home),
    );
    await pool.deleteMetadata(providerId, "broker-account");
    save("replacement");
    expect(
      await broker.report({ leaseId: lease.leaseId, ok: false, httpStatus }),
    ).toEqual({ ok: true });
    const current = pool.get("broker-account", providerId);
    expect(current?.health).toBe("ok");
    expect(current?.lastUsedAt).toBeUndefined();
    expect(
      broker.snapshot().accounts[`${providerId}:broker-account`]
        ?.lastReportedStatus,
    ).toBeNull();
  },
);
it("keeps broker token and organization on the same resolution receipt", async () => {
  const broker = new AccountPoolBroker({
    tokenResolver: async (provider, id) => {
      save("replacement", "replacement-organization");
      return resolveBrokerAccessToken(provider, id);
    },
  });
  const lease = await broker.lease({ providerId, sessionKey: "session" });
  expect(lease?.accessToken).toBe("replacement");
  expect(lease?.chatgptAccountId).toBe("replacement-organization");
});
it("refuses a broker token whose credential changed before publication", async () => {
  const broker = new AccountPoolBroker({
    tokenResolver: async (provider, id) => {
      const token = await resolveBrokerAccessToken(provider, id);
      save("replacement");
      return token;
    },
  });
  expect(await broker.lease({ providerId, sessionKey: "session" })).toBeNull();
  expect(broker.health().activeLeases).toBe(0);
});
it("preserves a later failure while an older broker success awaits accounting", async () => {
  const pool = getDefaultAccountPool();
  const broker = new AccountPoolBroker({ pool });
  const first = await broker.lease({ providerId, sessionKey: "first" });
  const second = await broker.lease({ providerId, sessionKey: "second" });
  assert(first && second);
  const entered = gate();
  const release = gate();
  const recordCall = pool.recordCall.bind(pool);
  vi.spyOn(pool, "recordCall").mockImplementationOnce(async (...args) => {
    entered.open();
    await release.promise;
    return recordCall(...args);
  });
  const success = broker.report({ leaseId: first.leaseId, ok: true });
  await entered.promise;
  const failure = broker.report({
    leaseId: second.leaseId,
    ok: false,
    httpStatus: 401,
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  release.open();
  await Promise.all([success, failure]);
  expect(pool.get("broker-account", providerId)?.health).toBe("needs-reauth");
  expect(
    broker.snapshot().accounts[`${providerId}:broker-account`]
      ?.lastReportedStatus?.ok,
  ).toBe(false);
});
it("rechecks a broker health baseline inside the metadata writer", async () => {
  const pool = getDefaultAccountPool();
  const account = pool.get("broker-account", providerId);
  assert(account);
  await pool.upsert({
    ...account,
    health: "rate-limited",
    healthDetail: { until: Date.now() - 1, lastChecked: 1 },
  });
  const broker = new AccountPoolBroker({ pool });
  const lease = await broker.lease({ providerId, sessionKey: "session" });
  assert(lease);
  const entered = gate();
  const release = gate();
  const deps = (pool as unknown as { deps: AccountPoolDeps }).deps;
  const write = deps.writeAccount.bind(deps);
  vi.spyOn(deps, "writeAccount").mockImplementation(
    async (account, options) => {
      if (account.health === "ok") {
        entered.open();
        await release.promise;
      }
      return (await write(account, options)) === true;
    },
  );
  const success = broker.report({ leaseId: lease.leaseId, ok: true });
  await entered.promise;
  await pool.markNeedsReauth("broker-account", "new-external-failure", {
    providerId,
  });
  release.open();
  await success;
  expect(pool.get("broker-account", providerId)?.health).toBe("needs-reauth");
  expect(pool.get("broker-account", providerId)?.healthDetail?.lastError).toBe(
    "new-external-failure",
  );
});
it("starts broker expiry after resolution and preserves legacy resolver wire shape", async () => {
  let now = 1;
  const broker = new AccountPoolBroker({
    now: () => now,
    leaseTtlMs: 1000,
    tokenResolver: async () => {
      now = 5000;
      return { accessToken: "injected", accessExpiresAt: 10000 };
    },
  });
  const lease = await broker.lease({ providerId, sessionKey: "session" });
  assert(lease);
  expect(lease.leaseExpiresAt).toBe(6000);
  expect(lease?.chatgptAccountId).toBe("original");
  expect(await broker.report({ leaseId: lease.leaseId, ok: true })).toEqual({
    ok: true,
  });
  now = 6000;
  expect(await broker.report({ leaseId: lease.leaseId, ok: true })).toEqual({
    ok: false,
    error: "expired_lease",
  });
  expect(await broker.report({ leaseId: lease.leaseId, ok: true })).toEqual({
    ok: false,
    error: "unknown_lease",
  });
  const token = await resolveBrokerAccessToken(providerId, "broker-account");
  expect(Object.keys(token).sort()).toEqual(["accessExpiresAt", "accessToken"]);
});
