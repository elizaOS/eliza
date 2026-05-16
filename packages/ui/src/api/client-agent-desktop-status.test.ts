import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBootConfig } from "../config/boot-config";
import { ElizaClient } from "./client-base";
import "./client-agent";
import type { AgentRequestTransport } from "./transport";

function makeClientWithTransport(
  payloads: Record<string, Record<string, unknown>>,
) {
  const request = vi.fn<AgentRequestTransport["request"]>(async (url) => {
    const parsed = new URL(url);
    const key = `${parsed.pathname}${parsed.search}`;
    const payload = payloads[key] ?? payloads[parsed.pathname] ?? {};
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const client = new ElizaClient("http://agent.example:31337", "token");
  client.setRequestTransport({ request });
  return { client, request };
}

function installDesktopRpc(
  request: Record<string, (params?: unknown) => Promise<unknown>>,
) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __ELIZA_ELECTROBUN_RPC__: {
        request,
        onMessage: vi.fn(),
        offMessage: vi.fn(),
      },
    },
  });
}

describe("ElizaClient desktop status RPC fallback", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "window");
  });

  it("falls back to HTTP when the desktop agent status RPC times out", async () => {
    installDesktopRpc({
      getAgentStatus: vi.fn(() => new Promise(() => undefined)),
    });
    const { client, request } = makeClientWithTransport({
      "/api/status": { state: "running", agentName: "Milady" },
    });

    await expect(client.getStatus()).resolves.toEqual({
      state: "running",
      agentName: "Milady",
    });

    expect(request).toHaveBeenCalledWith(
      "http://agent.example:31337/api/status",
      expect.any(Object),
      { timeoutMs: 10_000 },
    );
  });

  it("keeps using desktop RPC status when it answers", async () => {
    installDesktopRpc({
      getAgentStatus: vi.fn(async () => ({
        state: "running",
        agentName: "Milady",
      })),
    });
    const { client, request } = makeClientWithTransport({});

    await expect(client.getStatus()).resolves.toEqual({
      state: "running",
      agentName: "Milady",
    });

    expect(request).not.toHaveBeenCalled();
  });

  it("falls back for self-status and runtime snapshot reads", async () => {
    installDesktopRpc({
      getRuntimeSnapshot: vi.fn(() => new Promise(() => undefined)),
    });
    const { client, request } = makeClientWithTransport({
      "/api/agent/self-status": { state: "running", model: "eliza-1-0_8b" },
      "/api/runtime?depth=1&maxArrayLength=2": { ok: true },
    });

    await expect(client.getAgentSelfStatus()).resolves.toEqual({
      state: "running",
      model: "eliza-1-0_8b",
    });
    await expect(
      client.getRuntimeSnapshot({ depth: 1, maxArrayLength: 2 }),
    ).resolves.toEqual({ ok: true });

    expect(request).toHaveBeenCalledWith(
      "http://agent.example:31337/api/agent/self-status",
      expect.any(Object),
      { timeoutMs: 10_000 },
    );
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:31337/api/runtime?depth=1&maxArrayLength=2",
      expect.any(Object),
      { timeoutMs: 10_000 },
    );
  });
});
