import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const runtimeMock = vi.hoisted(() => ({
  isElectrobunRuntime: vi.fn(),
}));

const bridgeMock = vi.hoisted(() => ({
  getElectrobunRendererRpc: vi.fn(),
}));

vi.mock("../bridge/electrobun-runtime", () => runtimeMock);
vi.mock("../bridge/electrobun-rpc", () => bridgeMock);

import {
  desktopLocalAgentTransportForUrl,
  isElectrobunLocalMode,
} from "./desktop-local-agent-transport";

const IPC_BASE = "eliza-local-agent://ipc";

describe("desktopLocalAgentTransportForUrl (#12180)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns null for non-IPC URLs even under Electrobun", async () => {
    runtimeMock.isElectrobunRuntime.mockReturnValue(true);
    await expect(
      desktopLocalAgentTransportForUrl("http://127.0.0.1:31337/api/health"),
    ).resolves.toBeNull();
    await expect(
      desktopLocalAgentTransportForUrl("https://agent.example.com/api/health"),
    ).resolves.toBeNull();
    await expect(
      desktopLocalAgentTransportForUrl("http://localhost:2138"),
    ).resolves.toBeNull();
  });

  it("returns null for the IPC base when NOT under Electrobun (mobile keeps its own transport)", async () => {
    runtimeMock.isElectrobunRuntime.mockReturnValue(false);
    expect(isElectrobunLocalMode(`${IPC_BASE}/api/health`)).toBe(false);
    await expect(
      desktopLocalAgentTransportForUrl(`${IPC_BASE}/api/health`),
    ).resolves.toBeNull();
  });

  it("resolves a transport for the IPC base under Electrobun and routes through localAgentRequest", async () => {
    runtimeMock.isElectrobunRuntime.mockReturnValue(true);
    const localAgentRequest = vi.fn().mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
    });
    const request = { localAgentRequest };
    bridgeMock.getElectrobunRendererRpc.mockReturnValue({ request });

    expect(isElectrobunLocalMode(`${IPC_BASE}/api/health`)).toBe(true);
    const transport = await desktopLocalAgentTransportForUrl(
      `${IPC_BASE}/api/health`,
    );
    expect(transport).not.toBeNull();

    const response = await transport?.request(
      `${IPC_BASE}/api/health`,
      { headers: { "Content-Type": "application/json" } },
      { timeoutMs: 1234 },
    );

    expect(localAgentRequest).toHaveBeenCalledWith({
      path: "/api/health",
      method: "GET",
      headers: { "content-type": "application/json" },
      body: null,
      timeoutMs: 1234,
    });
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ ok: true });
  });

  it("throws a clear not-yet-implemented error when the RPC handler is missing (dormant/safe)", async () => {
    runtimeMock.isElectrobunRuntime.mockReturnValue(true);
    // No localAgentRequest on the RPC bridge — item 4 has not landed.
    bridgeMock.getElectrobunRendererRpc.mockReturnValue({ request: {} });

    const transport = await desktopLocalAgentTransportForUrl(
      `${IPC_BASE}/api/health`,
    );
    expect(transport).not.toBeNull();
    await expect(
      transport?.request(`${IPC_BASE}/api/health`, {}),
    ).rejects.toThrow(/localAgentRequest is not registered/);
  });

  it("forwards a POST body through the RPC handler", async () => {
    runtimeMock.isElectrobunRuntime.mockReturnValue(true);
    const localAgentRequest = vi
      .fn()
      .mockResolvedValue({ status: 201, body: "{}" });
    bridgeMock.getElectrobunRendererRpc.mockReturnValue({
      request: { localAgentRequest },
    });

    const transport = await desktopLocalAgentTransportForUrl(
      `${IPC_BASE}/api/conversations`,
    );
    await transport?.request(`${IPC_BASE}/api/conversations`, {
      method: "POST",
      body: '{"title":"hi"}',
    });

    expect(localAgentRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/conversations",
        method: "POST",
        body: '{"title":"hi"}',
      }),
    );
  });
});

/**
 * The resolver order is load-bearing (Decision 1): the new desktop local-agent
 * resolver must sit immediately before `desktopHttpTransportForUrl` (external)
 * in BOTH the ElizaClient chain and the fetchWithCsrf chain, after android + iOS
 * and before native-cloud + fetch. Asserted at the source level because booting
 * the full client to observe ordering pulls a large module graph.
 */
describe("resolver order (#12180)", () => {
  const clientBaseSrc = readFileSync(
    join(import.meta.dirname, "client-base.ts"),
    "utf8",
  );
  const csrfSrc = readFileSync(
    join(import.meta.dirname, "csrf-client.ts"),
    "utf8",
  );

  const EXPECTED_ORDER = [
    "androidNativeAgentTransportForUrl",
    "iosInProcessAgentTransportForUrl",
    "desktopLocalAgentTransportForUrl",
    "desktopHttpTransportForUrl",
    "nativeCloudHttpTransportForUrl",
  ];

  function resolverOrderIn(src: string): string[] {
    // The resolver chain assigns via `??`. Collect the transport calls in the
    // order they appear inside the chain expression.
    const seen: Array<{ name: string; index: number }> = [];
    for (const name of EXPECTED_ORDER) {
      // Match the call form used in the chain, e.g. `desktopHttpTransportForUrl(`.
      const idx = src.indexOf(`${name}(`);
      expect(idx, `${name} present in chain`).toBeGreaterThan(-1);
      seen.push({ name, index: idx });
    }
    return [...seen].sort((a, b) => a.index - b.index).map((e) => e.name);
  }

  it("orders resolvers android → iOS → desktop-local-agent → desktop-http → native-cloud in client-base.ts", () => {
    expect(resolverOrderIn(clientBaseSrc)).toEqual(EXPECTED_ORDER);
  });

  it("orders resolvers identically in csrf-client.ts", () => {
    expect(resolverOrderIn(csrfSrc)).toEqual(EXPECTED_ORDER);
  });

  it("routes desktop-local-agent immediately before desktop-http in both chains", () => {
    for (const src of [clientBaseSrc, csrfSrc]) {
      const local = src.indexOf("desktopLocalAgentTransportForUrl(");
      const http = src.indexOf("desktopHttpTransportForUrl(");
      // Both appear as imports too; the chain call is the later occurrence, but
      // the relative order (local before http) holds for the first call site
      // because the import lines are alphabetized the same way. Assert on the
      // chain by scanning past the import block.
      const chainStart = src.indexOf(
        "await androidNativeAgentTransportForUrl(",
      );
      const chainLocal = src.indexOf(
        "desktopLocalAgentTransportForUrl(",
        chainStart,
      );
      const chainHttp = src.indexOf("desktopHttpTransportForUrl(", chainStart);
      expect(local).toBeGreaterThan(-1);
      expect(http).toBeGreaterThan(-1);
      expect(chainLocal).toBeGreaterThan(-1);
      expect(chainHttp).toBeGreaterThan(chainLocal);
    }
  });
});
