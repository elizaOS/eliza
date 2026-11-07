import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";

describe("Cloudflare authentication state in Workerd", () => {
  let worker: Miniflare;
  let directory: string;
  let script: string;
  function start(persist = directory) {
    return new Miniflare({
      compatibilityDate: "2026-04-01",
      compatibilityFlags: ["nodejs_compat"],
      modules: [{ type: "ESModule", path: "worker.mjs", contents: script }],
      durableObjects: {
        AUTHENTICATION_STATE: {
          className: "AuthenticationState",
          useSQLite: true,
        },
      },
      durableObjectsPersist: persist,
    });
  }
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "cloud-auth-state-"));
    const build = await Bun.build({
      entrypoints: [
        join(
          import.meta.dir,
          "../test/fixtures/authentication-state-worker.ts",
        ),
      ],
      target: "browser",
      external: ["node:*", "cloudflare:*"],
      conditions: ["eliza-source"],
    });
    if (!build.success)
      throw new AggregateError(build.logs, "Workerd fixture build failed");
    script = await build.outputs[0]!.text();
    worker = start();
  }, 60_000);
  afterAll(async () => {
    await worker?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function request(input: {
    organization?: string;
    user?: string;
    operation: string;
    key: string;
    value?: string;
    seconds?: number;
    expiresAt?: number;
    nonce?: string;
  }) {
    const response = await worker.dispatchFetch("https://auth-state.test/", {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "Content-Type": "application/json" },
    });
    expect(response.status).toBe(200);
    return response.json();
  }
  test("persists complete bindings and permits exactly one concurrent consumer after restart", async () => {
    const value = JSON.stringify({
      uri: "https://eliza.example/認証",
      chainId: 1,
      marker: "é".repeat(4096),
    });
    expect(await request({ operation: "set", key: "nonce-one", value })).toBe(
      "OK",
    );
    await worker.dispose();
    worker = start();
    expect(await request({ operation: "get", key: "nonce-one" })).toBe(value);
    const results = await Promise.all(
      Array.from({ length: 32 }, () =>
        request({ operation: "getdel", key: "nonce-one" }),
      ),
    );
    expect(results.filter((result) => result === value)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(31);
    expect(await request({ operation: "get", key: "nonce-one" })).toBeNull();
  }, 60_000);
  test("rejects expired markers and isolates distinct auth keys", async () => {
    await request({
      operation: "set",
      key: "revoke-expiring",
      value: "1",
      seconds: 1,
    });
    await request({
      operation: "set",
      key: "revoke-retained",
      value: "1",
      seconds: 30,
    });
    await Bun.sleep(1100);
    expect(
      await request({ operation: "get", key: "revoke-expiring" }),
    ).toBeNull();
    expect(
      await request({ operation: "getdel", key: "revoke-expiring" }),
    ).toBeNull();
    expect(await request({ operation: "get", key: "revoke-retained" })).toBe(
      "1",
    );
  });
  test("runs actual voice consent issuance and enforces user scope and replay protection", async () => {
    const issued = (await request({
      operation: "issue-consent",
      key: "user-a",
    })) as { nonce: string };
    expect(typeof issued.nonce).toBe("string");
    expect(
      await request({
        operation: "consume-consent",
        key: "user-b",
        nonce: issued.nonce,
      }),
    ).toBe(false);
    expect(
      await request({
        operation: "consume-consent",
        key: "user-a",
        nonce: issued.nonce,
      }),
    ).toBe(true);
    expect(
      await request({
        operation: "consume-consent",
        key: "user-a",
        nonce: issued.nonce,
      }),
    ).toBe(false);
  });
  test("enforces one voice connection claim and retains actual JWT revocation across restart", async () => {
    const claims = await Promise.all(
      Array.from({ length: 24 }, () =>
        request({ operation: "claim-voice", key: "voice-jti" }),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(
      await request({ operation: "is-revoked", key: "internal-jti" }),
    ).toBe(false);
    await request({ operation: "revoke", key: "internal-jti" });
    await worker.dispose();
    worker = start();
    expect(
      await request({ operation: "is-revoked", key: "internal-jti" }),
    ).toBe(true);
    expect(await request({ operation: "is-revoked", key: "other-jti" })).toBe(
      false,
    );
    expect(await request({ operation: "claim-voice", key: "voice-jti" })).toBe(
      false,
    );
  }, 60_000);

  test("validates a real signed SIWE message and rejects replay without Redis", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const nonce = (await request({
      operation: "issue-siwe",
      key: "unused",
    })) as string;
    const message = createSiweMessage({
      address: account.address,
      chainId: 1,
      domain: "auth-state.test",
      nonce,
      uri: "https://auth-state.test",
      version: "1",
    });
    const signature = await account.signMessage({ message });
    const verify = () =>
      worker.dispatchFetch("https://auth-state.test/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "verify-siwe",
          key: "unused",
          message,
          signature,
        }),
      });
    const accepted = await verify();
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ address: account.address });
    expect((await verify()).status).toBe(401);
  });
  test("keeps voice session lookup scoped to both organization and user", async () => {
    await request({ operation: "record-session", key: "session-a" });
    expect(
      await request({ operation: "lookup-session", key: "session-a" }),
    ).toBe("directory-jti");
    expect(
      await request({
        operation: "lookup-session",
        key: "session-a",
        organization: "org-b",
      }),
    ).toBeNull();
    expect(
      await request({
        operation: "lookup-session",
        key: "session-a",
        user: "user-b",
      }),
    ).toBeNull();
  });
  test("refuses consent when the explicitly selected durable binding is missing", async () => {
    const response = await worker.dispatchFetch("https://auth-state.test/", {
      method: "POST",
      body: JSON.stringify({
        operation: "missing-binding",
        key: "user-a",
        nonce: "absent",
      }),
    });
    expect(response.status).toBe(503);
  });
  test("imports original expirations and cannot restore a consumed nonce after activation", async () => {
    await worker.dispose();
    const persist = join(directory, "migration");
    worker = start(persist);
    const entry = {
      operation: "import",
      key: "snapshot-consume",
      value: "bound-nonce",
      expiresAt: Date.now() + 60_000,
    };
    expect(await request(entry)).toBe("imported");
    expect(await request(entry)).toBe("identical");
    const conflicting = await worker.dispatchFetch("https://auth-state.test/", {
      method: "POST",
      body: JSON.stringify({ ...entry, value: "different" }),
    });
    expect(conflicting.status).toBe(409);
    expect(
      await request({
        operation: "import",
        key: "snapshot-expired",
        value: "stale",
        expiresAt: Date.now() - 1,
      }),
    ).toBe("expired");
    expect(
      await request({
        operation: "import",
        key: "snapshot-ttl",
        value: "short",
        expiresAt: Date.now() + 1000,
      }),
    ).toBe("imported");
    expect(await request({ operation: "getdel", key: entry.key })).toBe(
      "bound-nonce",
    );
    await worker.dispose();
    worker = start(persist);
    const replay = await worker.dispatchFetch("https://auth-state.test/", {
      method: "POST",
      body: JSON.stringify(entry),
    });
    expect(replay.status).toBe(409);
    expect(await request({ operation: "get", key: entry.key })).toBeNull();
    await Bun.sleep(1100);
    expect(await request({ operation: "get", key: "snapshot-ttl" })).toBeNull();
    expect(
      await request({ operation: "get", key: "snapshot-expired" }),
    ).toBeNull();
  }, 60_000);
});
