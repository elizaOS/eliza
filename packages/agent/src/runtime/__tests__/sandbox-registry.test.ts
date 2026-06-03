/**
 * Unit tests for the agent-side SandboxRegistry (Path A fix #1). The Upstash
 * REST API is exercised through a mocked global `fetch` so we record the exact
 * commands that would be sent. Everything else runs the real production code.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSandboxRegistryFromEnv,
  SandboxRegistry,
} from "../sandbox-registry.ts";

vi.mock("@elizaos/core", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

interface Recorded {
  url: string;
  body: unknown;
}

const recorded: Recorded[] = [];
const store = new Map<string, string>();

function installFetch(): void {
  recorded.length = 0;
  store.clear();
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    recorded.push({ url, body });

    if (url.endsWith("/pipeline")) {
      // body is array of command arrays
      for (const cmd of body as string[][]) {
        if (cmd[0] === "SET") store.set(cmd[1], cmd[2]);
      }
      return {
        ok: true,
        json: async () => (body as unknown[]).map(() => ({ result: "OK" })),
      } as unknown as Response;
    }
    // single command
    const cmd = body as string[];
    if (cmd[0] === "GET") {
      return {
        ok: true,
        json: async () => ({ result: store.get(cmd[1]) ?? null }),
      } as unknown as Response;
    }
    if (cmd[0] === "DEL") {
      for (const k of cmd.slice(1)) store.delete(k);
      return {
        ok: true,
        json: async () => ({ result: cmd.length - 1 }),
      } as unknown as Response;
    }
    return { ok: true, json: async () => ({ result: null }) } as Response;
  }) as unknown as typeof fetch;
}

const baseConfig = {
  redisUrl: "https://example.upstash.io",
  redisToken: "tok",
  agentId: "char-123",
  serverName: "sandbox-abc",
  serverUrl: "http://1.2.3.4:1999/api",
  ttlSeconds: 90,
};

describe("SandboxRegistry (agent runtime)", () => {
  beforeEach(() => installFetch());
  afterEach(() => vi.restoreAllMocks());

  it("register() writes both keys with TTL via the pipeline endpoint", async () => {
    const reg = new SandboxRegistry(baseConfig);
    await reg.register();

    const pipe = recorded.find((r) => r.url.endsWith("/pipeline"));
    expect(pipe).toBeTruthy();
    const cmds = pipe?.body as string[][];
    expect(cmds).toContainEqual([
      "SET",
      "server:sandbox-abc:url",
      "http://1.2.3.4:1999/api",
      "EX",
      "90",
    ]);
    expect(cmds).toContainEqual([
      "SET",
      "agent:char-123:server",
      "sandbox-abc",
      "EX",
      "90",
    ]);
  });

  it("unregister() deletes keys only when they still point at this sandbox", async () => {
    const reg = new SandboxRegistry(baseConfig);
    await reg.register();
    await reg.unregister();
    expect(store.has("agent:char-123:server")).toBe(false);
    expect(store.has("server:sandbox-abc:url")).toBe(false);
  });

  it("unregister() does NOT delete keys that another sandbox overwrote", async () => {
    const reg = new SandboxRegistry(baseConfig);
    await reg.register();
    // Simulate another sandbox claiming the agent.
    store.set("agent:char-123:server", "sandbox-other");
    store.set("server:sandbox-abc:url", "http://9.9.9.9:1/api");
    await reg.unregister();
    expect(store.get("agent:char-123:server")).toBe("sandbox-other");
    expect(store.get("server:sandbox-abc:url")).toBe("http://9.9.9.9:1/api");
  });
});

describe("buildSandboxRegistryFromEnv", () => {
  it("returns null when the SANDBOX_REGISTRY_* env has missing fields (feature flag off)", () => {
    expect(buildSandboxRegistryFromEnv({})).toBeNull();
    expect(
      buildSandboxRegistryFromEnv({
        SANDBOX_REGISTRY_REDIS_URL: "x",
        SANDBOX_REGISTRY_REDIS_TOKEN: "y",
        // missing agent id / server name / url
      }),
    ).toBeNull();
  });

  it("keys on SANDBOX_ROUTE_AGENT_ID (character_id) when present", async () => {
    installFetch();
    const reg = buildSandboxRegistryFromEnv({
      SANDBOX_REGISTRY_REDIS_URL: "https://example.upstash.io",
      SANDBOX_REGISTRY_REDIS_TOKEN: "tok",
      SANDBOX_AGENT_ID: "sandbox-id-2facbf59",
      SANDBOX_ROUTE_AGENT_ID: "char-a1f08a41",
      SANDBOX_SERVER_NAME: "sandbox-name",
      SANDBOX_PUBLIC_URL: "http://1.2.3.4:1999/api",
    });
    expect(reg).not.toBeNull();
    await reg?.register();
    const pipe = recorded.find((r) => r.url.endsWith("/pipeline"));
    const cmds = pipe?.body as string[][];
    // Must register under the routing character_id, not the sandbox id.
    expect(cmds.some((c) => c[1] === "agent:char-a1f08a41:server")).toBe(true);
    expect(cmds.some((c) => c[1] === "agent:sandbox-id-2facbf59:server")).toBe(
      false,
    );
  });

  it("falls back to SANDBOX_AGENT_ID when no route id is injected", () => {
    const reg = buildSandboxRegistryFromEnv({
      SANDBOX_REGISTRY_REDIS_URL: "https://example.upstash.io",
      SANDBOX_REGISTRY_REDIS_TOKEN: "tok",
      SANDBOX_AGENT_ID: "sandbox-id",
      SANDBOX_SERVER_NAME: "sandbox-name",
      SANDBOX_PUBLIC_URL: "http://1.2.3.4:1999/api",
    });
    expect(reg).not.toBeNull();
  });
});
