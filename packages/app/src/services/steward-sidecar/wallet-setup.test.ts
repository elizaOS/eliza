import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ElizaError } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CREDENTIALS_FILE } from "./types";
import { ensureWalletSetup } from "./wallet-setup";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    fsyncSync: vi.fn(actual.fsyncSync),
  };
});

const API_BASE = "http://127.0.0.1:3200";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("steward wallet first-launch setup", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "steward-wallet-setup-"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it.each([
    [409, "Tenant already exists"],
    [400, "Tenant already exists"],
    [409, "Tenant id has retained historical state and cannot be reused"],
  ])(
    "fails with a typed recovery error instead of using an unregistered key (HTTP %i: %s)",
    async (status, error) => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `${API_BASE}/tenants`) {
          return jsonResponse(status, { ok: false, error });
        }
        return jsonResponse(403, { ok: false, error: "Invalid tenant key" });
      });
      vi.stubGlobal("fetch", fetchMock);

      const setup = ensureWalletSetup(
        null,
        API_BASE,
        undefined,
        dataDir,
        () => {},
      );

      await expect(setup).rejects.toBeInstanceOf(ElizaError);
      await expect(setup).rejects.toMatchObject({
        code: "STEWARD_TENANT_CREDENTIALS_LOST",
      });
      await expect(setup).rejects.toThrow(path.join(dataDir, CREDENTIALS_FILE));
      // Setup must stop before attempting agent creation with a key the
      // Steward server never registered.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(path.join(dataDir, CREDENTIALS_FILE))).toBe(false);
    },
  );

  it("surfaces other tenant-creation failures as typed errors", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(403, { ok: false, error: "Platform key required" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const setup = ensureWalletSetup(
      null,
      API_BASE,
      undefined,
      dataDir,
      () => {},
    );

    await expect(setup).rejects.toMatchObject({
      code: "STEWARD_TENANT_CREATE_FAILED",
    });
    await expect(setup).rejects.toThrow(
      "Failed to create Steward tenant (HTTP 403): Platform key required",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["HTTP 500", () => jsonResponse(500, { ok: false, error: "db down" })],
    [
      "a non-JSON body",
      () => new Response("<html>bad gateway</html>", { status: 502 }),
    ],
  ])(
    "keeps the tenant checkpoint when tenant creation fails with %s",
    async (_label, respond) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => respond()),
      );

      await expect(
        ensureWalletSetup(null, API_BASE, undefined, dataDir, () => {}),
      ).rejects.toMatchObject({ code: "STEWARD_TENANT_CREATE_FAILED" });
      // The server may have stored the tenant before failing, so the only
      // copy of its key must survive for the next launch to resume with.
      expect(readCheckpoint()).toMatchObject({ tenantId: "elizaos-desktop" });
      expect(typeof readCheckpoint().tenantApiKey).toBe("string");
    },
  );

  it("drops the tenant checkpoint when tenant creation is rejected with a 4xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(400, { ok: false, error: "Invalid tenant id" }),
      ),
    );

    await expect(
      ensureWalletSetup(null, API_BASE, undefined, dataDir, () => {}),
    ).rejects.toMatchObject({ code: "STEWARD_TENANT_CREATE_FAILED" });
    expect(fs.existsSync(path.join(dataDir, CREDENTIALS_FILE))).toBe(false);
  });

  function readCheckpoint(): Record<string, unknown> {
    return JSON.parse(
      fs.readFileSync(path.join(dataDir, CREDENTIALS_FILE), "utf-8"),
    ) as Record<string, unknown>;
  }

  function tenantKeyHash(init: RequestInit | undefined): unknown {
    return (JSON.parse(String(init?.body)) as { apiKeyHash?: unknown })
      .apiKeyHash;
  }

  it("keeps the tenant key when agent creation fails and resumes with it", async () => {
    const tenantHashes: unknown[] = [];
    let agentAttempts = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === `${API_BASE}/tenants`) {
          tenantHashes.push(tenantKeyHash(init));
          return tenantHashes.length === 1
            ? jsonResponse(200, { ok: true })
            : jsonResponse(409, { ok: false, error: "Tenant already exists" });
        }
        if (url === `${API_BASE}/agents`) {
          agentAttempts += 1;
          if (agentAttempts === 1) {
            throw new DOMException("The operation timed out.", "TimeoutError");
          }
          return jsonResponse(200, {
            ok: true,
            data: { id: "eliza-wallet", walletAddress: "0xabc" },
          });
        }
        if (url === `${API_BASE}/agents/eliza-wallet/token`) {
          return jsonResponse(200, { ok: true, data: { token: "agent-tok" } });
        }
        return jsonResponse(404, { ok: false, error: "unexpected" });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      ensureWalletSetup(null, API_BASE, undefined, dataDir, () => {}),
    ).rejects.toThrow("timed out");

    const checkpoint = readCheckpoint();
    expect(checkpoint).toMatchObject({ tenantId: "elizaos-desktop" });
    expect(typeof checkpoint.tenantApiKey).toBe("string");
    expect(checkpoint.walletAddress).toBeUndefined();

    const credentials = await ensureWalletSetup(
      checkpoint as never,
      API_BASE,
      undefined,
      dataDir,
      () => {},
    );

    expect(credentials).toMatchObject({
      tenantApiKey: checkpoint.tenantApiKey,
      agentId: "eliza-wallet",
      walletAddress: "0xabc",
      agentToken: "agent-tok",
    });
    // The resumed launch re-registers the same key rather than a fresh one.
    expect(tenantHashes).toHaveLength(2);
    expect(tenantHashes[1]).toBe(tenantHashes[0]);
    expect(readCheckpoint()).toMatchObject({ agentToken: "agent-tok" });
  });

  it("recovers an agent a previous attempt created before being cut off", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${API_BASE}/tenants`) {
        return jsonResponse(409, { ok: false, error: "Tenant already exists" });
      }
      if (url === `${API_BASE}/agents`) {
        return jsonResponse(409, { ok: false, error: "Agent already exists" });
      }
      if (url === `${API_BASE}/agents/eliza-wallet`) {
        return jsonResponse(200, {
          ok: true,
          data: { id: "eliza-wallet", walletAddress: "0xdef" },
        });
      }
      if (url === `${API_BASE}/agents/eliza-wallet/token`) {
        return jsonResponse(200, { ok: true, data: { token: "agent-tok" } });
      }
      return jsonResponse(404, { ok: false, error: "unexpected" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const credentials = await ensureWalletSetup(
      { tenantId: "elizaos-desktop", tenantApiKey: "saved-key" },
      API_BASE,
      undefined,
      dataDir,
      () => {},
    );

    expect(credentials).toMatchObject({
      tenantApiKey: "saved-key",
      walletAddress: "0xdef",
      agentToken: "agent-tok",
    });
  });

  it("reports lost credentials when a resumed key is rejected by Steward", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${API_BASE}/tenants`) {
        return jsonResponse(409, { ok: false, error: "Tenant already exists" });
      }
      return jsonResponse(403, { ok: false, error: "Invalid tenant key" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      ensureWalletSetup(
        { tenantId: "elizaos-desktop", tenantApiKey: "stale-key" },
        API_BASE,
        undefined,
        dataDir,
        () => {},
      ),
    ).rejects.toMatchObject({ code: "STEWARD_TENANT_CREDENTIALS_LOST" });
  });

  it("gives Postgres recovery guidance when the sidecar uses DATABASE_URL", async () => {
    const databaseUrl = "postgres://steward:hunter2@db.internal:5432/steward";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(409, { ok: false, error: "Tenant already exists" }),
      ),
    );

    const setup = ensureWalletSetup(
      null,
      API_BASE,
      undefined,
      dataDir,
      () => {},
      undefined,
      { databaseUrl },
    );

    await expect(setup).rejects.toMatchObject({
      code: "STEWARD_TENANT_CREDENTIALS_LOST",
      context: expect.objectContaining({ stewardDatabase: "postgres" }),
    });
    await expect(setup).rejects.toThrow(
      "reset the Steward Postgres database configured by DATABASE_URL",
    );
    await expect(setup).rejects.not.toThrow("hunter2");
    await expect(setup).rejects.not.toThrow(
      `reset the local Steward vault by removing ${path.join(dataDir, "data")}`,
    );
  });
  it("preserves the resumable checkpoint when a replacement write fails", async () => {
    const checkpoint = {
      tenantId: "eliza-local",
      tenantApiKey: "synthetic-tenant-key",
      agentId: "synthetic-agent",
      walletAddress: "0xsynthetic-wallet",
    };
    const target = path.join(dataDir, CREDENTIALS_FILE);
    const original = JSON.stringify(checkpoint);
    fs.writeFileSync(target, original, { mode: 0o600 });
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fs.writeFileSync).mockImplementationOnce((destination) => {
      realFs.writeFileSync(destination, "{", { mode: 0o600 });
      throw Object.assign(new Error("synthetic disk-full failure"), {
        code: "ENOSPC",
      });
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          ok: true,
          data: { token: "synthetic-agent-token" },
        }),
      ),
    );
    const updateStatus = vi.fn();
    await expect(
      ensureWalletSetup(checkpoint, API_BASE, undefined, dataDir, updateStatus),
    ).rejects.toThrow("synthetic disk-full failure");
    expect(fs.readFileSync(target, "utf8")).toBe(original);
    expect(fs.readdirSync(dataDir)).toEqual([CREDENTIALS_FILE]);
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it("surfaces a real directory-flush failure on Windows without losing the checkpoint", async () => {
    const checkpoint = {
      tenantId: "eliza-local",
      tenantApiKey: "synthetic-tenant-key",
      agentId: "synthetic-agent",
      walletAddress: "0xsynthetic-wallet",
    };
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    // Supply a valid descriptor even on hosts that cannot open directories;
    // this regression injects the flush error independently of host support.
    vi.mocked(fs.openSync)
      .mockImplementationOnce(realFs.openSync)
      .mockImplementationOnce(() =>
        realFs.openSync(path.join(dataDir, CREDENTIALS_FILE), "r"),
      );
    vi.mocked(fs.fsyncSync)
      .mockImplementationOnce(realFs.fsyncSync)
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("synthetic directory I/O failure"), {
          code: "EIO",
        });
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          ok: true,
          data: { token: "synthetic-agent-token" },
        }),
      ),
    );
    const updateStatus = vi.fn();
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    if (!platform) throw new Error("process.platform descriptor is missing");
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      await expect(
        ensureWalletSetup(
          checkpoint,
          API_BASE,
          undefined,
          dataDir,
          updateStatus,
        ),
      ).rejects.toThrow("synthetic directory I/O failure");
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    expect(
      JSON.parse(fs.readFileSync(path.join(dataDir, CREDENTIALS_FILE), "utf8")),
    ).toEqual({
      ...checkpoint,
      agentToken: "synthetic-agent-token",
    });
    expect(fs.readdirSync(dataDir)).toEqual([CREDENTIALS_FILE]);
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it("publishes complete private credentials when replacing an older permissive file", async () => {
    const checkpoint = {
      tenantId: "eliza-local",
      tenantApiKey: "synthetic-tenant-key",
      agentId: "synthetic-agent",
      walletAddress: "0xsynthetic-wallet",
    };
    const target = path.join(dataDir, CREDENTIALS_FILE);
    fs.writeFileSync(target, JSON.stringify(checkpoint), { mode: 0o644 });
    fs.chmodSync(target, 0o644);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          ok: true,
          data: { token: "synthetic-agent-token" },
        }),
      ),
    );
    const result = await ensureWalletSetup(
      checkpoint,
      API_BASE,
      undefined,
      dataDir,
      () => {},
    );
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual(result);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dataDir)).toEqual([CREDENTIALS_FILE]);
  });
});
