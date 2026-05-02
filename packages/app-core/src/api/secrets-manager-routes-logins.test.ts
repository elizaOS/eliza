import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createManager,
  createVault,
  type ExecFn,
  generateMasterKey,
  inMemoryMasterKey,
  type SavedLogin,
  type UnifiedLoginListResult,
  type UnifiedLoginReveal,
  type Vault,
} from "@elizaos/vault";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetSharedVaultForTesting } from "../services/vault-mirror";
import {
  _resetSecretsManagerForTesting,
  _setSecretsManagerForTesting,
  handleSecretsManagerRoute,
} from "./secrets-manager-routes";

/** No external CLI is available in CI — every adapter call must short-circuit. */
const noopExec: ExecFn = async () => {
  throw new Error("exec stub: no external CLI in test");
};

function buildTestManager(vault: Vault) {
  const manager = createManager({ vault, exec: noopExec });
  _setSecretsManagerForTesting(manager);
  return manager;
}

interface Harness {
  baseUrl: string;
  dispose: () => Promise<void>;
}

async function startApiHarness(): Promise<Harness> {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const handled = await handleSecretsManagerRoute(
        req,
        res,
        url.pathname,
        (req.method ?? "GET").toUpperCase(),
      );
      if (!handled && !res.headersSent) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "not-found" }));
      }
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    dispose: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe("secrets-manager logins routes", () => {
  let harness: Harness | null;
  let workDir: string | null;

  beforeEach(async () => {
    harness = null;
    workDir = await fs.mkdtemp(join(tmpdir(), "eliza-logins-routes-"));
    // Inject a test vault under the shared singleton AND wire the
    // manager around the same vault with a stub exec so external
    // backend probes never reach the real OS or the user's `op`/`bw`.
    const testVault = createVault({
      workDir,
      masterKey: inMemoryMasterKey(generateMasterKey()),
    });
    _resetSharedVaultForTesting(testVault);
    buildTestManager(testVault);
  });

  afterEach(async () => {
    await harness?.dispose();
    if (workDir) await fs.rm(workDir, { recursive: true, force: true });
    _resetSharedVaultForTesting(null);
    _resetSecretsManagerForTesting();
  });

  it("POST /api/secrets/logins persists a login", async () => {
    harness = await startApiHarness();
    const res = await fetch(`${harness.baseUrl}/api/secrets/logins`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        domain: "github.com",
        username: "alice@example.com",
        password: "hunter2",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Round-trip via GET (single).
    const getRes = await fetch(
      `${harness.baseUrl}/api/secrets/logins/github.com/${encodeURIComponent("alice@example.com")}`,
    );
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { ok: boolean; login: SavedLogin };
    expect(getBody.login.domain).toBe("github.com");
    expect(getBody.login.username).toBe("alice@example.com");
    expect(getBody.login.password).toBe("hunter2");
  });

  it("POST rejects missing fields with 400", async () => {
    harness = await startApiHarness();
    const cases: Record<string, unknown>[] = [
      { username: "u", password: "p" },
      { domain: "x.com", password: "p" },
      { domain: "x.com", username: "u" },
      { domain: "x.com", username: "u", password: "" },
    ];
    for (const body of cases) {
      const res = await fetch(`${harness.baseUrl}/api/secrets/logins`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  it("GET /api/secrets/logins lists all without revealing passwords", async () => {
    harness = await startApiHarness();
    await fetch(`${harness.baseUrl}/api/secrets/logins`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        domain: "github.com",
        username: "alice",
        password: "VERY-SECRET-1",
      }),
    });
    await fetch(`${harness.baseUrl}/api/secrets/logins`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        domain: "gitlab.com",
        username: "bob",
        password: "VERY-SECRET-2",
      }),
    });

    const res = await fetch(`${harness.baseUrl}/api/secrets/logins`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as UnifiedLoginListResult & { ok: boolean };
    expect(body.logins.length).toBe(2);
    expect(body.failures).toEqual([]);
    for (const entry of body.logins) {
      expect(entry.source).toBe("in-house");
    }
    const text = JSON.stringify(body);
    expect(text).not.toContain("VERY-SECRET-1");
    expect(text).not.toContain("VERY-SECRET-2");
  });

  it("GET ?domain= filters by domain", async () => {
    harness = await startApiHarness();
    await fetch(`${harness.baseUrl}/api/secrets/logins`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        domain: "github.com",
        username: "alice",
        password: "p1",
      }),
    });
    await fetch(`${harness.baseUrl}/api/secrets/logins`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        domain: "gitlab.com",
        username: "bob",
        password: "p2",
      }),
    });

    const res = await fetch(
      `${harness.baseUrl}/api/secrets/logins?domain=github.com`,
    );
    const body = (await res.json()) as UnifiedLoginListResult;
    expect(body.logins.length).toBe(1);
    expect(body.logins[0]?.domain).toBe("github.com");
    expect(body.logins[0]?.source).toBe("in-house");
    expect(body.logins[0]?.identifier).toBe("github.com:alice");
  });

  it("GET /api/secrets/logins/reveal returns full credentials for in-house", async () => {
    harness = await startApiHarness();
    await fetch(`${harness.baseUrl}/api/secrets/logins`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        domain: "github.com",
        username: "alice",
        password: "hunter2",
      }),
    });
    const params = new URLSearchParams({
      source: "in-house",
      identifier: "github.com:alice",
    });
    const res = await fetch(
      `${harness.baseUrl}/api/secrets/logins/reveal?${params.toString()}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      login: UnifiedLoginReveal;
    };
    expect(body.login.password).toBe("hunter2");
    expect(body.login.username).toBe("alice");
    expect(body.login.source).toBe("in-house");
  });

  it("GET reveal rejects an unknown source", async () => {
    harness = await startApiHarness();
    const params = new URLSearchParams({
      source: "lastpass",
      identifier: "x:y",
    });
    const res = await fetch(
      `${harness.baseUrl}/api/secrets/logins/reveal?${params.toString()}`,
    );
    expect(res.status).toBe(400);
  });

  it("GET reveal returns 404 for missing in-house entry", async () => {
    harness = await startApiHarness();
    const params = new URLSearchParams({
      source: "in-house",
      identifier: "nope.example:none",
    });
    const res = await fetch(
      `${harness.baseUrl}/api/secrets/logins/reveal?${params.toString()}`,
    );
    expect(res.status).toBe(404);
  });

  it("GET single returns 404 for unknown user", async () => {
    harness = await startApiHarness();
    const res = await fetch(
      `${harness.baseUrl}/api/secrets/logins/no-such.test/missing`,
    );
    expect(res.status).toBe(404);
  });

  it("DELETE removes a login", async () => {
    harness = await startApiHarness();
    await fetch(`${harness.baseUrl}/api/secrets/logins`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        domain: "github.com",
        username: "alice",
        password: "p1",
      }),
    });
    const delRes = await fetch(
      `${harness.baseUrl}/api/secrets/logins/github.com/alice`,
      { method: "DELETE" },
    );
    expect(delRes.status).toBe(200);
    const getRes = await fetch(
      `${harness.baseUrl}/api/secrets/logins/github.com/alice`,
    );
    expect(getRes.status).toBe(404);
  });

  it("autoallow PUT/GET round-trips per domain", async () => {
    harness = await startApiHarness();
    const initial = await fetch(
      `${harness.baseUrl}/api/secrets/logins/github.com/autoallow`,
    );
    const initialBody = (await initial.json()) as {
      ok: boolean;
      allowed: boolean;
    };
    expect(initialBody.allowed).toBe(false);

    const putRes = await fetch(
      `${harness.baseUrl}/api/secrets/logins/github.com/autoallow`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allowed: true }),
      },
    );
    expect(putRes.status).toBe(200);

    const after = await fetch(
      `${harness.baseUrl}/api/secrets/logins/github.com/autoallow`,
    );
    const afterBody = (await after.json()) as {
      ok: boolean;
      allowed: boolean;
    };
    expect(afterBody.allowed).toBe(true);

    // Other domains unaffected.
    const other = await fetch(
      `${harness.baseUrl}/api/secrets/logins/gitlab.com/autoallow`,
    );
    const otherBody = (await other.json()) as { allowed: boolean };
    expect(otherBody.allowed).toBe(false);
  });

  it("autoallow PUT rejects non-boolean", async () => {
    harness = await startApiHarness();
    const res = await fetch(
      `${harness.baseUrl}/api/secrets/logins/github.com/autoallow`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allowed: "yes" }),
      },
    );
    expect(res.status).toBe(400);
  });
});
