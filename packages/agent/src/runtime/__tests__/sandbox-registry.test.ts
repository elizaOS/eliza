/**
 * Unit tests for the agent-side SandboxRegistry (Path A fix #1). The Upstash
 * REST API is exercised through a mocked global `fetch` so we record the exact
 * commands that would be sent. Everything else runs the real production code.
 */

import net from "node:net";
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

  it("accepts a redis:// URL with NO token (TCP transport carries auth inline)", () => {
    const reg = buildSandboxRegistryFromEnv({
      SANDBOX_REGISTRY_REDIS_URL: "redis://default:pw@host:6379",
      // no SANDBOX_REGISTRY_REDIS_TOKEN
      SANDBOX_AGENT_ID: "sandbox-id",
      SANDBOX_SERVER_NAME: "sandbox-name",
      SANDBOX_PUBLIC_URL: "http://1.2.3.4:1999/api",
    });
    expect(reg).not.toBeNull();
  });

  it("still requires a token for an https:// (Upstash REST) URL", () => {
    expect(
      buildSandboxRegistryFromEnv({
        SANDBOX_REGISTRY_REDIS_URL: "https://example.upstash.io",
        // no token
        SANDBOX_AGENT_ID: "sandbox-id",
        SANDBOX_SERVER_NAME: "sandbox-name",
        SANDBOX_PUBLIC_URL: "http://1.2.3.4:1999/api",
      }),
    ).toBeNull();
  });
});

/**
 * In-process RESP server: parses the client's RESP2 command stream against a
 * real `node:net` socket and replies like Redis (SET/GET/DEL/AUTH/SELECT),
 * exercising the registry's native TCP transport end-to-end without an external
 * Redis. `requirePassword` + `fragmentReplies` let tests assert auth and the
 * partial-read parser.
 */
interface FakeRedis {
  port: number;
  store: Map<string, string>;
  authedWith: string[][];
  close: () => Promise<void>;
}

async function startFakeRedis(opts?: {
  requirePassword?: string;
  fragmentReplies?: boolean;
}): Promise<FakeRedis> {
  const store = new Map<string, string>();
  const authedWith: string[][] = [];

  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let authed = !opts?.requirePassword;

    const send = (s: string): void => {
      if (opts?.fragmentReplies) {
        // Write one byte at a time to force the client's incremental parser.
        for (const byte of Buffer.from(s)) socket.write(Buffer.from([byte]));
      } else {
        socket.write(s);
      }
    };

    const tryParseCommand = (): string[] | null => {
      if (buf.length === 0 || buf[0] !== 0x2a) return null; // '*'
      const headerEnd = buf.indexOf("\r\n");
      if (headerEnd === -1) return null;
      const argc = Number(buf.toString("utf8", 1, headerEnd));
      let offset = headerEnd + 2;
      const args: string[] = [];
      for (let i = 0; i < argc; i++) {
        if (buf[offset] !== 0x24) return null; // '$'
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
        if (verb === "AUTH") {
          authedWith.push(cmd.slice(1));
          authed = cmd[cmd.length - 1] === opts?.requirePassword;
          send(authed ? "+OK\r\n" : "-WRONGPASS invalid password\r\n");
        } else if (!authed) {
          send("-NOAUTH Authentication required.\r\n");
        } else if (verb === "SELECT") {
          send("+OK\r\n");
        } else if (verb === "SET") {
          store.set(cmd[1], cmd[2]);
          send("+OK\r\n");
        } else if (verb === "GET") {
          const v = store.get(cmd[1]);
          send(
            v === undefined
              ? "$-1\r\n"
              : `$${Buffer.byteLength(v)}\r\n${v}\r\n`,
          );
        } else if (verb === "DEL") {
          let n = 0;
          for (const k of cmd.slice(1)) if (store.delete(k)) n++;
          send(`:${n}\r\n`);
        } else {
          send("-ERR unknown command\r\n");
        }
        cmd = tryParseCommand();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as net.AddressInfo;
  return {
    port: addr.port,
    store,
    authedWith,
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
    vi.restoreAllMocks();
  });

  const tcpConfig = (port: number, auth = "") => ({
    redisUrl: `redis://${auth}127.0.0.1:${port}`,
    agentId: "char-tcp",
    serverName: "sandbox-tcp",
    serverUrl: "http://5.6.7.8:1999/api",
    ttlSeconds: 90,
  });

  it("register() writes both keys over a redis:// socket", async () => {
    fake = await startFakeRedis();
    const reg = new SandboxRegistry(tcpConfig(fake.port));
    await reg.register();
    expect(fake.store.get("server:sandbox-tcp:url")).toBe(
      "http://5.6.7.8:1999/api",
    );
    expect(fake.store.get("agent:char-tcp:server")).toBe("sandbox-tcp");
  });

  it("authenticates with the URL password before writing", async () => {
    fake = await startFakeRedis({ requirePassword: "s3cret" });
    const reg = new SandboxRegistry(tcpConfig(fake.port, "default:s3cret@"));
    await reg.register();
    expect(fake.authedWith).toContainEqual(["default", "s3cret"]);
    expect(fake.store.get("agent:char-tcp:server")).toBe("sandbox-tcp");
  });

  it("unregister() deletes only keys still pointing at this sandbox", async () => {
    fake = await startFakeRedis();
    const reg = new SandboxRegistry(tcpConfig(fake.port));
    await reg.register();
    fake.store.set("agent:char-tcp:server", "sandbox-other");
    await reg.unregister();
    // agent key was overwritten -> kept; server url still ours -> deleted.
    expect(fake.store.get("agent:char-tcp:server")).toBe("sandbox-other");
    expect(fake.store.has("server:sandbox-tcp:url")).toBe(false);
  });

  it("parses replies that arrive one byte at a time (fragmented reads)", async () => {
    fake = await startFakeRedis({ fragmentReplies: true });
    const reg = new SandboxRegistry(tcpConfig(fake.port));
    await reg.register();
    expect(fake.store.get("agent:char-tcp:server")).toBe("sandbox-tcp");
  });
});
