/**
 * Pins the compare-and-swap commit of a subscription token refresh against a
 * concurrent logout or re-login. The harness is real: `credentials.ts` and
 * the encrypted `account-storage.ts` run against a temporary state
 * directory; only `globalThis.fetch` is replaced by a gated token response
 * that each test releases after mutating the store.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createIsolatedAccountStoragePolicy,
  deleteAccount,
  listAccounts,
  loadAccount,
} from "./account-storage.ts";
import { getAccessToken, saveCredentials } from "./credentials.ts";

const PROVIDER = "anthropic-subscription" as const;
const ACCOUNT = "default";
const originalFetch = globalThis.fetch;
const tempHomes: string[] = [];

function useTempElizaHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-auth-cas-"));
  tempHomes.push(dir);
  vi.stubEnv("ELIZA_HOME", dir);
  vi.stubEnv("ELIZA_STATE_DIR", dir);
  vi.stubEnv("HOME", dir);
  vi.stubEnv("USERPROFILE", dir);
  return dir;
}

interface GatedTokenResponse {
  /** Resolves once the refresh request has reached the network boundary. */
  requested: Promise<void>;
  /** Lets the pending token response reach `getAccessToken`. */
  release: () => void;
  calls: () => number;
}

function gateTokenResponse(body: {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}): GatedTokenResponse {
  let release: () => void = () => {};
  let markRequested: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });
  const network = vi.fn(async () => {
    markRequested();
    await gate;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  globalThis.fetch = network as unknown as typeof fetch;
  return { requested, release, calls: () => network.mock.calls.length };
}

function seedExpiredAccount(
  stateRoot: string,
  idToken?: string,
): ReturnType<typeof createIsolatedAccountStoragePolicy> {
  const policy = createIsolatedAccountStoragePolicy(stateRoot);
  saveCredentials(
    PROVIDER,
    {
      access: "expired-access",
      refresh: "old-family",
      expires: Date.now() - 1_000,
      ...(idToken !== undefined ? { idToken } : {}),
    },
    ACCOUNT,
    policy,
  );
  return policy;
}

describe("refresh commit compare-and-swap (#31951)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    for (const dir of tempHomes.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("A: a refresh that lands after logout does not resurrect the account", async () => {
    const stateRoot = useTempElizaHome();
    const policy = seedExpiredAccount(stateRoot);
    const gate = gateTokenResponse({
      access_token: "new",
      refresh_token: "old-family-rotated",
      expires_in: 3600,
    });

    const pending = getAccessToken(PROVIDER, ACCOUNT, {
      outcome: true,
      storagePolicy: policy,
    });
    await gate.requested;
    deleteAccount(PROVIDER, ACCOUNT, policy);
    gate.release();
    const outcome = await pending;

    expect(outcome).toMatchObject({ ok: false, kind: "auth" });
    expect(loadAccount(PROVIDER, ACCOUNT, policy)).toBeNull();
    expect(listAccounts(PROVIDER, policy)).toEqual([]);
  });

  it("B: a refresh that lands after a re-login keeps the fresh credentials", async () => {
    const stateRoot = useTempElizaHome();
    const policy = seedExpiredAccount(stateRoot);
    const gate = gateTokenResponse({
      access_token: "stale-refresh-access",
      refresh_token: "old-family-rotated",
      expires_in: 3600,
    });

    const pending = getAccessToken(PROVIDER, ACCOUNT, {
      outcome: true,
      storagePolicy: policy,
    });
    await gate.requested;
    const freshExpires = Date.now() + 60 * 60_000;
    saveCredentials(
      PROVIDER,
      {
        access: "fresh-login-access",
        refresh: "fresh-login-refresh",
        expires: freshExpires,
      },
      ACCOUNT,
      policy,
    );
    gate.release();
    const outcome = await pending;

    expect(outcome).toEqual({
      ok: true,
      accessToken: "fresh-login-access",
      expiresAt: freshExpires,
      refreshed: false,
    });
    expect(loadAccount(PROVIDER, ACCOUNT, policy)?.credentials).toMatchObject({
      access: "fresh-login-access",
      refresh: "fresh-login-refresh",
    });
  });

  it("C: an uncontended refresh still commits, rotates the refresh token, and carries the id_token forward", async () => {
    const stateRoot = useTempElizaHome();
    const policy = seedExpiredAccount(stateRoot, "id-token-login");
    const before = loadAccount(PROVIDER, ACCOUNT, policy);
    if (!before) throw new Error("seeded account is missing");
    const gate = gateTokenResponse({
      access_token: "new",
      refresh_token: "old-family-rotated",
      expires_in: 3600,
    });
    gate.release();

    const outcome = await getAccessToken(PROVIDER, ACCOUNT, {
      outcome: true,
      storagePolicy: policy,
    });

    expect(outcome).toMatchObject({
      ok: true,
      accessToken: "new",
      refreshed: true,
    });
    const after = loadAccount(PROVIDER, ACCOUNT, policy);
    expect(after?.credentials).toMatchObject({
      access: "new",
      refresh: "old-family-rotated",
      idToken: "id-token-login",
    });
    expect(after).toMatchObject({
      label: before.label,
      source: before.source,
      createdAt: before.createdAt,
    });
    expect(gate.calls()).toBe(1);
  });

  it("D: concurrent callers for one account spend the refresh grant once", async () => {
    const stateRoot = useTempElizaHome();
    const policy = seedExpiredAccount(stateRoot);
    const gate = gateTokenResponse({
      access_token: "new",
      refresh_token: "old-family-rotated",
      expires_in: 3600,
    });

    const pending = Promise.all([
      getAccessToken(PROVIDER, ACCOUNT, { storagePolicy: policy }),
      getAccessToken(PROVIDER, ACCOUNT, { storagePolicy: policy }),
    ]);
    await gate.requested;
    gate.release();

    expect(await pending).toEqual(["new", "new"]);
    expect(gate.calls()).toBe(1);
    expect(loadAccount(PROVIDER, ACCOUNT, policy)?.credentials.refresh).toBe(
      "old-family-rotated",
    );
  });
});
