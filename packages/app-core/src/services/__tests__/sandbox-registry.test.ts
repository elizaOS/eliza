/**
 * Unit tests for SandboxRegistry. The registry speaks two transports selected
 * by URL scheme: Upstash REST (`https://`, exercised via a mocked `fetch`) and
 * native RESP/TCP (`redis://`, exercised against an in-process fake Redis).
 * Everything else runs the real production code path. Mirrors the agent-copy
 * test (`packages/agent/src/runtime/__tests__/sandbox-registry.test.ts`).
 */

import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  buildSandboxRegistryFromEnv,
  SandboxRegistry,
} from "../sandbox-registry";

interface Recorded {
  url: string;
  body: unknown;
}

const recorded: Recorded[] = [];
const store = new Map<string, string>();
let failNextFetch = false;

function installFetch(): void {
  recorded.length = 0;
  store.clear();
  failNextFetch = false;
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    if (failNextFetch) {
      failNextFetch = false;
      throw new Error("simulated upstash failure");
    }
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    recorded.push({ url, body });

    if (url.endsWith("/pipeline")) {
      for (const cmd of body as string[][]) {
        if (cmd[0] === "SET") store.set(cmd[1], cmd[2]);
      }
      return {
        ok: true,
        json: async () => (body as unknown[]).map(() => ({ result: "OK" })),
      } as unknown as Response;
    }
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

const CONFIG = {
  redisUrl: "https://example.upstash.io",
  redisToken: "tok",
  agentId: "agent-42",
  serverName: "sandbox-agent-42",
  serverUrl: "http://10.0.0.7:18791",
  ttlSeconds: 60,
};

describe("SandboxRegistry (Upstash REST transport)", () => {
  beforeEach(() => installFetch());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("register() writes both routing keys with the configured TTL", async () => {
    const registry = new SandboxRegistry(CONFIG);
    await registry.register();

    const pipe = recorded.find((r) => r.url.endsWith("/pipeline"));
    const cmds = pipe?.body as string[][];
    expect(cmds).toContainEqual([
      "SET",
      "server:sandbox-agent-42:url",
      "http://10.0.0.7:18791",
      "EX",
      "60",
    ]);
    expect(cmds).toContainEqual([
      "SET",
      "agent:agent-42:server",
      "sandbox-agent-42",
      "EX",
      "60",
    ]);
  });

  it("unregister() deletes only keys that still point at this sandbox", async () => {
    const registry = new SandboxRegistry(CONFIG);
    await registry.register();
    store.set("agent:agent-42:server", "sandbox-agent-42-replacement");
    await registry.unregister();
    expect(store.has("server:sandbox-agent-42:url")).toBe(false);
    expect(store.get("agent:agent-42:server")).toBe(
      "sandbox-agent-42-replacement",
    );
  });

  it("startHeartbeat() refreshes on the interval; errors do not kill the timer", async () => {
    vi.useFakeTimers();
    const registry = new SandboxRegistry(CONFIG);
    await registry.register();
    recorded.length = 0;

    registry.startHeartbeat(30_000);

    failNextFetch = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(recorded.filter((r) => r.url.endsWith("/pipeline"))).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(recorded.filter((r) => r.url.endsWith("/pipeline"))).toHaveLength(1);

    registry.stopHeartbeat();
  });

  it("stopHeartbeat() halts the timer", async () => {
    vi.useFakeTimers();
    const registry = new SandboxRegistry(CONFIG);
    await registry.register();
    recorded.length = 0;

    registry.startHeartbeat(30_000);
    registry.stopHeartbeat();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(recorded).toHaveLength(0);
  });
});

describe("buildSandboxRegistryFromEnv", () => {
  it("returns null when any required var is missing (REST URL needs a token)", () => {
    const complete = {
      SANDBOX_REGISTRY_REDIS_URL: "https://x.upstash.io",
      SANDBOX_REGISTRY_REDIS_TOKEN: "t",
      SANDBOX_AGENT_ID: "a",
      SANDBOX_SERVER_NAME: "s",
      SANDBOX_PUBLIC_URL: "http://1.2.3.4:1",
    };
    expect(buildSandboxRegistryFromEnv(complete)).not.toBeNull();

    for (const key of Object.keys(complete) as Array<keyof typeof complete>) {
      const partial = { ...complete, [key]: "" };
      expect(buildSandboxRegistryFromEnv(partial)).toBeNull();
    }
  });

  it("accepts a redis:// URL with no token (TCP carries auth inline)", () => {
    expect(
      buildSandboxRegistryFromEnv({
        SANDBOX_REGISTRY_REDIS_URL: "redis://default:pw@host:6379",
        SANDBOX_AGENT_ID: "a",
        SANDBOX_SERVER_NAME: "s",
        SANDBOX_PUBLIC_URL: "http://1.2.3.4:1",
      }),
    ).not.toBeNull();
  });

  it("trims whitespace and rejects whitespace-only values", () => {
    expect(
      buildSandboxRegistryFromEnv({
        SANDBOX_REGISTRY_REDIS_URL: "https://x.upstash.io",
        SANDBOX_REGISTRY_REDIS_TOKEN: "t",
        SANDBOX_AGENT_ID: "a",
        SANDBOX_SERVER_NAME: "s",
        SANDBOX_PUBLIC_URL: "   ",
      }),
    ).toBeNull();
  });
});

/**
 * In-process RESP server: parses the client's RESP2 command stream and replies
 * like Redis, exercising the native TCP transport end-to-end without an
 * external Redis.
 */
interface FakeRedis {
  port: number;
  store: Map<string, string>;
  close: () => Promise<void>;
}

async function startFakeRedis(): Promise<FakeRedis> {
  const store = new Map<string, string>();
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    const tryParseCommand = (): string[] | null => {
      if (buf.length === 0 || buf[0] !== 0x2a) return null;
      const headerEnd = buf.indexOf("\r\n");
      if (headerEnd === -1) return null;
      const argc = Number(buf.toString("utf8", 1, headerEnd));
      let offset = headerEnd + 2;
      const args: string[] = [];
      for (let i = 0; i < argc; i++) {
        if (buf[offset] !== 0x24) return null;
        const lenEnd = buf.indexOf("\r\n", offset);
        if (lenEnd === -1) return null;
        const len = Number(buf.toString("utf8", offset + 1, lenEnd));
        const dataStart = lenEnd + 2;
        const dataEnd = dataStart + len;
        if (buf.length < dataEnd + 2) return null;
        args.push(buf.toString("utf8", dataStart, dataEnd));
        offset = dataEnd + 2;
      }
      buf = buf.subarray(offset);
      return args;
    };
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      let cmd = tryParseCommand();
      while (cmd) {
        const verb = cmd[0]?.toUpperCase();
        if (verb === "AUTH" || verb === "SELECT") socket.write("+OK\r\n");
        else if (verb === "SET") {
          store.set(cmd[1], cmd[2]);
          socket.write("+OK\r\n");
        } else if (verb === "GET") {
          const v = store.get(cmd[1]);
          socket.write(
            v === undefined
              ? "$-1\r\n"
              : `$${Buffer.byteLength(v)}\r\n${v}\r\n`,
          );
        } else if (verb === "DEL") {
          let n = 0;
          for (const k of cmd.slice(1)) if (store.delete(k)) n++;
          socket.write(`:${n}\r\n`);
        } else socket.write("-ERR unknown\r\n");
        cmd = tryParseCommand();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as net.AddressInfo;
  return {
    port: addr.port,
    store,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

describe("SandboxRegistry (native TCP transport)", () => {
  let fake: FakeRedis;
  afterEach(async () => {
    await fake?.close();
  });

  it("register()/unregister() round-trip over a redis:// socket", async () => {
    fake = await startFakeRedis();
    const reg = new SandboxRegistry({
      ...CONFIG,
      redisUrl: `redis://default:pw@127.0.0.1:${fake.port}`,
      redisToken: undefined,
    });
    await reg.register();
    expect(fake.store.get("agent:agent-42:server")).toBe("sandbox-agent-42");
    await reg.unregister();
    expect(fake.store.has("agent:agent-42:server")).toBe(false);
  });
});
