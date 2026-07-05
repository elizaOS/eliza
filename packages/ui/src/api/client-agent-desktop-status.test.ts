/**
 * Unit coverage for the desktop agent-status client verb. Transport stubbed,
 * boot config injected, no live agent.
 */
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
  globals: Record<string, unknown> = {},
) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      ...globals,
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
      "/api/status": { state: "running", agentName: "Eliza" },
    });

    await expect(client.getStatus()).resolves.toEqual({
      state: "running",
      agentName: "Eliza",
    });

    expect(request).toHaveBeenCalledWith(
      "http://agent.example:31337/api/status",
      expect.any(Object),
      { timeoutMs: 10_000 },
    );
  });

  it("keeps the desktop RPC status verbatim when it already confirms readiness", async () => {
    installDesktopRpc({
      getAgentStatus: vi.fn(async () => ({
        state: "running",
        agentName: "Eliza",
        canRespond: true,
      })),
    });
    const { client, request } = makeClientWithTransport({});

    await expect(client.getStatus()).resolves.toEqual({
      state: "running",
      agentName: "Eliza",
      canRespond: true,
    });

    // RPC already reports first-turn readiness — no HTTP merge needed.
    expect(request).not.toHaveBeenCalled();
  });

  it("merges /api/status readiness into a running desktop RPC snapshot missing canRespond", async () => {
    // Regression for #14040 sub-defect 1: the electrobun `AgentStatusSnapshot`
    // has no `canRespond`, so a cloud-routed / model-less agent that is up but
    // hasn't confirmed first-turn readiness would poll to
    // `deriveAgentReady=false` FOREVER off the RPC branch. When the process is
    // running but the snapshot doesn't confirm `canRespond`, fill readiness from
    // `/api/status` (mirrors the Android lifecycle branch).
    const getAgentStatus = vi.fn(async () => ({
      state: "running",
      agentName: "Eliza",
    }));
    installDesktopRpc({ getAgentStatus });
    const { client, request } = makeClientWithTransport({
      "/api/status": {
        state: "running",
        canRespond: true,
        model: "eliza-1-2b",
      },
    });

    await expect(client.getStatus()).resolves.toEqual({
      state: "running",
      agentName: "Eliza",
      canRespond: true,
      model: "eliza-1-2b",
    });

    expect(getAgentStatus).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:31337/api/status",
      expect.any(Object),
      { timeoutMs: 10_000 },
    );
  });

  it("falls back to the RPC snapshot when the /api/status merge fetch is unreachable", async () => {
    // The readiness merge must never make a running agent LOOK worse: an
    // unreachable `/api/status` keeps the RPC snapshot rather than throwing.
    const getAgentStatus = vi.fn(async () => ({
      state: "running",
      agentName: "Eliza",
    }));
    installDesktopRpc({ getAgentStatus });
    const request = vi.fn<AgentRequestTransport["request"]>(async () => {
      throw new Error("network down");
    });
    const client = new ElizaClient("http://agent.example:31337", "token");
    client.setRequestTransport({ request });

    await expect(client.getStatus()).resolves.toEqual({
      state: "running",
      agentName: "Eliza",
    });

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not merge /api/status for a non-running desktop RPC snapshot", async () => {
    // Only a running-but-unconfirmed process needs the readiness backfill; a
    // starting/error snapshot is authoritative and must not trigger an HTTP
    // probe (which would 404/throw during boot).
    const getAgentStatus = vi.fn(async () => ({
      state: "starting",
      agentName: "Eliza",
    }));
    installDesktopRpc({ getAgentStatus });
    const { client, request } = makeClientWithTransport({
      "/api/status": { state: "running", canRespond: true },
    });

    await expect(client.getStatus()).resolves.toEqual({
      state: "starting",
      agentName: "Eliza",
    });

    expect(request).not.toHaveBeenCalled();
  });

  it("skips local desktop status RPC for a configured external API base", async () => {
    const getAgentStatus = vi.fn(async () => ({
      state: "error",
      agentName: "wrong-local-agent",
    }));
    installDesktopRpc(
      { getAgentStatus },
      { __ELIZA_DESKTOP_EXTERNAL_API_BASE__: "http://agent.example:31337" },
    );
    const { client, request } = makeClientWithTransport({
      "/api/status": { state: "running", agentName: "Cloud Eliza" },
    });

    await expect(client.getStatus()).resolves.toEqual({
      state: "running",
      agentName: "Cloud Eliza",
    });

    expect(getAgentStatus).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:31337/api/status",
      expect.any(Object),
      { timeoutMs: 10_000 },
    );
  });

  it("uses desktop boot progress when available", async () => {
    const progress = {
      state: "running",
      phase: "running",
      lastError: null,
      pluginsLoaded: 22,
      pluginsFailed: 0,
      database: "ok",
      agentName: "Eliza",
      port: 31337,
      startedAt: 1234,
      updatedAt: "2026-05-17T00:00:00.000Z",
    };
    installDesktopRpc({
      bootProgress: vi.fn(async () => progress),
    });
    const { client, request } = makeClientWithTransport({});

    await expect(client.getBootProgress()).resolves.toEqual(progress);

    expect(request).not.toHaveBeenCalled();
  });

  it("returns null when desktop boot progress is unavailable", async () => {
    installDesktopRpc({});
    const { client, request } = makeClientWithTransport({});

    await expect(client.getBootProgress()).resolves.toBeNull();

    expect(request).not.toHaveBeenCalled();
  });

  it("falls back for self-status and runtime snapshot reads", async () => {
    installDesktopRpc({
      getRuntimeSnapshot: vi.fn(() => new Promise(() => undefined)),
    });
    const { client, request } = makeClientWithTransport({
      "/api/agent/self-status": { state: "running", model: "eliza-1-2b" },
      "/api/runtime?depth=1&maxArrayLength=2": { ok: true },
    });

    await expect(client.getAgentSelfStatus()).resolves.toEqual({
      state: "running",
      model: "eliza-1-2b",
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
