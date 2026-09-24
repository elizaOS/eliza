/**
 * Exercises first-launch Steward wallet setup and its persisted retry checkpoint
 * through the real setup function with a deterministic mocked HTTP boundary.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CREDENTIALS_FILE, type StewardCredentialCheckpoint } from "./types";
import { ensureWalletSetup } from "./wallet-setup";

const API_BASE = "http://steward.local";
const WALLET = "0xabc";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubStewardFetch(tokenStages: Array<() => Response>) {
  const fetchMock = vi.fn(
    async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "POST" && url.endsWith("/tenants")) {
        return jsonResponse(200, {
          ok: true,
          data: { id: "elizaos-desktop" },
        });
      }
      if (method === "POST" && url.endsWith("/agents")) {
        return jsonResponse(200, {
          ok: true,
          data: { id: "eliza-wallet", walletAddress: WALLET },
        });
      }
      if (method === "POST" && url.endsWith("/agents/eliza-wallet/token")) {
        const stage = tokenStages.shift();
        if (!stage) throw new Error("unexpected extra token request");
        return stage();
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function readCheckpoint(dataDir: string): StewardCredentialCheckpoint {
  return JSON.parse(
    readFileSync(path.join(dataDir, CREDENTIALS_FILE), "utf8"),
  ) as StewardCredentialCheckpoint;
}

describe("ensureWalletSetup first-launch token acquisition", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "steward-wallet-"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("fails on a token 503 and persists a retryable checkpoint without a fake token", async () => {
    stubStewardFetch([() => jsonResponse(503, { error: "temporarily down" })]);

    await expect(
      ensureWalletSetup(null, API_BASE, undefined, dataDir, () => {}),
    ).rejects.toThrow(/HTTP 503.*temporarily down/i);

    const checkpoint = readCheckpoint(dataDir);
    expect(checkpoint).toMatchObject({
      tenantId: "elizaos-desktop",
      agentId: "eliza-wallet",
      walletAddress: WALLET,
    });
    expect(checkpoint).not.toHaveProperty("agentToken");
  });

  it("resumes an incomplete checkpoint without recreating the tenant or agent", async () => {
    const fetchMock = stubStewardFetch([
      () => jsonResponse(503, { error: "temporarily down" }),
      () =>
        jsonResponse(200, {
          ok: true,
          data: { token: " recovered-token " },
        }),
    ]);
    await expect(
      ensureWalletSetup(null, API_BASE, undefined, dataDir, () => {}),
    ).rejects.toThrow(/token/i);
    const checkpoint = readCheckpoint(dataDir);

    const completed = await ensureWalletSetup(
      checkpoint,
      API_BASE,
      undefined,
      dataDir,
      () => {},
    );

    expect(completed.agentToken).toBe("recovered-token");
    expect(readCheckpoint(dataDir).agentToken).toBe("recovered-token");
    const requestedUrls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(
      requestedUrls.filter((url) => url.endsWith("/tenants")),
    ).toHaveLength(1);
    expect(requestedUrls.filter((url) => url.endsWith("/agents"))).toHaveLength(
      1,
    );
    expect(
      requestedUrls.filter((url) => url.endsWith("/agents/eliza-wallet/token")),
    ).toHaveLength(2);
  });

  it.each([
    ["missing", { ok: true, data: {} }],
    ["whitespace-only", { ok: true, data: { token: "   " } }],
    [
      "unsuccessful envelope",
      { ok: false, data: { token: "must-not-be-accepted" } },
    ],
  ])(
    "rejects a %s token payload without fabricating success",
    async (_name, body) => {
      stubStewardFetch([() => jsonResponse(200, body)]);

      await expect(
        ensureWalletSetup(null, API_BASE, undefined, dataDir, () => {}),
      ).rejects.toThrow(/did not include a token/i);

      expect(readCheckpoint(dataDir)).not.toHaveProperty("agentToken");
    },
  );

  it("adds token-step context when the endpoint returns malformed JSON", async () => {
    stubStewardFetch([() => new Response("not-json", { status: 502 })]);

    await expect(
      ensureWalletSetup(null, API_BASE, undefined, dataDir, () => {}),
    ).rejects.toThrow(/agent token.*not valid JSON/i);
    expect(readCheckpoint(dataDir)).not.toHaveProperty("agentToken");
  });

  it("repairs a legacy empty-token credential file without recreating remote state", async () => {
    const legacyCredentials: StewardCredentialCheckpoint = {
      tenantId: "legacy-tenant",
      tenantApiKey: "legacy-key",
      agentId: "legacy-agent",
      agentToken: "",
      walletAddress: WALLET,
    };
    const fetchMock = vi.fn(
      async (_input: string | URL): Promise<Response> =>
        jsonResponse(200, {
          ok: true,
          data: { token: "legacy-recovered" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const completed = await ensureWalletSetup(
      legacyCredentials,
      API_BASE,
      undefined,
      dataDir,
      () => {},
    );

    expect(completed.agentToken).toBe("legacy-recovered");
    expect(readCheckpoint(dataDir).agentToken).toBe("legacy-recovered");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${API_BASE}/agents/legacy-agent/token`,
    );
  });

  it("persists a trimmed non-empty token and wallet on the happy path", async () => {
    stubStewardFetch([
      () =>
        jsonResponse(200, {
          ok: true,
          data: { token: " agent-token-xyz " },
        }),
    ]);

    const credentials = await ensureWalletSetup(
      null,
      API_BASE,
      undefined,
      dataDir,
      () => {},
    );

    expect(credentials.agentToken).toBe("agent-token-xyz");
    expect(credentials.walletAddress).toBe(WALLET);
    expect(existsSync(path.join(dataDir, CREDENTIALS_FILE))).toBe(true);
    expect(readCheckpoint(dataDir)).toMatchObject({
      agentToken: "agent-token-xyz",
      walletAddress: WALLET,
    });
  });
});
