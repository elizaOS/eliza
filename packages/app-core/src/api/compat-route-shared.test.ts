/**
 * Unit tests for the app-core compat HTTP shared primitives. Drives the real
 * module: ordered route-chain short-circuit, the bounded restart-reason queue,
 * JSON body reading (pre-parsed and streamed, including the 1 MiB cap), first-run
 * completion detection, configured agent-name lookup, and the Drizzle handle
 * grab. Fakes are HTTP streams and config objects — nothing under test is mocked.
 */
import * as fs from "node:fs";
import type http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { ElizaConfig } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CompatRouteChainEntry,
  type CompatRouteContext,
  type CompatRuntimeState,
  clearCompatRuntimeRestart,
  DATABASE_UNAVAILABLE_MESSAGE,
  getCompatDrizzleDb,
  getConfiguredCompatAgentName,
  hasCompatPersistedFirstRunState,
  isLoopbackRemoteAddress,
  isTrustedLocalRequest,
  readCompatJsonBody,
  runCompatRouteChain,
  scheduleCompatRuntimeRestart,
} from "./compat-route-shared.js";

const MAX_BODY_BYTES = 1_048_576;

function emptyState(pendingRestartReasons: string[] = []): CompatRuntimeState {
  return {
    current: null,
    pendingAgentName: null,
    pendingRestartReasons,
  };
}

function makeCtx(state: CompatRuntimeState = emptyState()): CompatRouteContext {
  return {
    req: {} as CompatRouteContext["req"],
    res: {} as CompatRouteContext["res"],
    state,
    method: "GET",
    url: new URL("http://localhost/api/anything"),
  };
}

function entry(
  id: string,
  handler: CompatRouteChainEntry["handler"],
): CompatRouteChainEntry {
  return { id, handler };
}

function responseSink(): http.ServerResponse & {
  jsonBody: () => unknown;
  status: () => number;
} {
  let body = "";
  const sink = {
    headersSent: false,
    statusCode: 200,
    setHeader: () => sink,
    end: (chunk?: unknown) => {
      body = typeof chunk === "string" ? chunk : String(chunk ?? "");
      sink.headersSent = true;
      return {} as http.ServerResponse;
    },
    jsonBody: () => (body ? JSON.parse(body) : undefined),
    status: () => sink.statusCode,
  };
  return sink as unknown as http.ServerResponse & {
    jsonBody: () => unknown;
    status: () => number;
  };
}

function requestFromChunks(
  chunks: Array<Buffer | string>,
  extra?: { body?: unknown },
): http.IncomingMessage & { destroyedFlag: boolean } {
  const req = {
    headers: { "content-type": "application/json" },
    method: "POST",
    url: "/api/compat",
    socket: { remoteAddress: "127.0.0.1" },
    destroyedFlag: false,
    destroy() {
      req.destroyedFlag = true;
    },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
    ...(extra ?? {}),
  };
  return req as http.IncomingMessage & { destroyedFlag: boolean };
}

describe("runCompatRouteChain", () => {
  it("returns false and runs nothing for an empty chain", async () => {
    expect(await runCompatRouteChain([], makeCtx())).toBe(false);
  });

  it("returns true when the only entry handles the request", async () => {
    const handled = await runCompatRouteChain(
      [entry("only", () => true)],
      makeCtx(),
    );
    expect(handled).toBe(true);
  });

  it("returns false when the only entry declines", async () => {
    const handled = await runCompatRouteChain(
      [entry("only", () => false)],
      makeCtx(),
    );
    expect(handled).toBe(false);
  });

  it("runs entries in array order and stops at the first truthy handler", async () => {
    const calls: string[] = [];
    const handled = await runCompatRouteChain(
      [
        entry("a", () => {
          calls.push("a");
          return false;
        }),
        entry("b", () => {
          calls.push("b");
          return true;
        }),
        entry("c", () => {
          calls.push("c");
          return true;
        }),
      ],
      makeCtx(),
    );
    expect(handled).toBe(true);
    expect(calls).toEqual(["a", "b"]);
  });

  it("awaits async handlers and still short-circuits on the first true", async () => {
    const calls: string[] = [];
    const handled = await runCompatRouteChain(
      [
        entry("a", async () => {
          await Promise.resolve();
          calls.push("a");
          return false;
        }),
        entry("b", async () => {
          await Promise.resolve();
          calls.push("b");
          return true;
        }),
        entry("c", () => {
          calls.push("c");
          return true;
        }),
      ],
      makeCtx(),
    );
    expect(handled).toBe(true);
    expect(calls).toEqual(["a", "b"]);
  });

  it("threads the same context object to every entry it runs", async () => {
    const ctx = makeCtx();
    const seen: CompatRouteContext[] = [];
    await runCompatRouteChain(
      [
        entry("a", (c) => {
          seen.push(c);
          return false;
        }),
        entry("b", (c) => {
          seen.push(c);
          return false;
        }),
      ],
      ctx,
    );
    expect(seen).toEqual([ctx, ctx]);
    expect(seen[0]).toBe(ctx);
  });
});

describe("scheduleCompatRuntimeRestart / clearCompatRuntimeRestart", () => {
  it("pushes the first reason onto an empty queue", () => {
    const state = emptyState();
    scheduleCompatRuntimeRestart(state, "plugin-reload");
    expect(state.pendingRestartReasons).toEqual(["plugin-reload"]);
  });

  it("appends a second distinct reason", () => {
    const state = emptyState(["plugin-reload"]);
    scheduleCompatRuntimeRestart(state, "config-write");
    expect(state.pendingRestartReasons).toEqual([
      "plugin-reload",
      "config-write",
    ]);
  });

  it("ignores a duplicate reason (including when the queue is at capacity)", () => {
    const state = emptyState(["plugin-reload", "config-write"]);
    scheduleCompatRuntimeRestart(state, "plugin-reload");
    expect(state.pendingRestartReasons).toEqual([
      "plugin-reload",
      "config-write",
    ]);

    const atCapacity = emptyState(
      Array.from({ length: 50 }, (_, i) => `reason-${i}`),
    );
    scheduleCompatRuntimeRestart(atCapacity, "reason-0");
    expect(atCapacity.pendingRestartReasons).toHaveLength(50);
    expect(atCapacity.pendingRestartReasons[0]).toBe("reason-0");
    expect(atCapacity.pendingRestartReasons[49]).toBe("reason-49");
  });

  it("treats whitespace and casing as distinct reasons (exact-string compare)", () => {
    const state = emptyState(["reload"]);
    scheduleCompatRuntimeRestart(state, "reload ");
    scheduleCompatRuntimeRestart(state, "Reload");
    expect(state.pendingRestartReasons).toEqual([
      "reload",
      "reload ",
      "Reload",
    ]);
  });

  it("on overflow keeps the oldest reason and the newest, dropping the middle", () => {
    const state = emptyState(
      Array.from({ length: 50 }, (_, i) => `reason-${i}`),
    );
    scheduleCompatRuntimeRestart(state, "reason-50");
    expect(state.pendingRestartReasons).toEqual(["reason-0", "reason-50"]);
  });

  it("can fill back up after an overflow splice", () => {
    const state = emptyState(
      Array.from({ length: 50 }, (_, i) => `reason-${i}`),
    );
    scheduleCompatRuntimeRestart(state, "overflow");
    scheduleCompatRuntimeRestart(state, "after-overflow");
    expect(state.pendingRestartReasons).toEqual([
      "reason-0",
      "overflow",
      "after-overflow",
    ]);
  });

  it("clear empties a populated queue and is a no-op on an already-empty queue", () => {
    const state = emptyState(["a", "b"]);
    clearCompatRuntimeRestart(state);
    expect(state.pendingRestartReasons).toEqual([]);
    clearCompatRuntimeRestart(state);
    expect(state.pendingRestartReasons).toEqual([]);
  });
});

describe("DATABASE_UNAVAILABLE_MESSAGE", () => {
  it("is the stable caller-facing copy for a missing Drizzle handle", () => {
    expect(DATABASE_UNAVAILABLE_MESSAGE).toBe(
      "Database not available. The agent may not be running or the database adapter is not initialized.",
    );
  });
});

describe("isLoopbackRemoteAddress (re-export)", () => {
  it("accepts IPv4 and IPv6 loopback spellings, including mapped forms", () => {
    expect(isLoopbackRemoteAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackRemoteAddress("127.1.2.3")).toBe(true);
    expect(isLoopbackRemoteAddress("::1")).toBe(true);
    expect(isLoopbackRemoteAddress("0:0:0:0:0:0:0:1")).toBe(true);
    expect(isLoopbackRemoteAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackRemoteAddress(" 127.0.0.1 ")).toBe(true);
  });

  it("rejects non-loopback, empty, and non-IP values", () => {
    expect(isLoopbackRemoteAddress("8.8.8.8")).toBe(false);
    expect(isLoopbackRemoteAddress("10.0.0.1")).toBe(false);
    expect(isLoopbackRemoteAddress("localhost")).toBe(false);
    expect(isLoopbackRemoteAddress("")).toBe(false);
    expect(isLoopbackRemoteAddress(null)).toBe(false);
    expect(isLoopbackRemoteAddress(undefined)).toBe(false);
  });
});

describe("isTrustedLocalRequest", () => {
  const ENV_KEYS = [
    "ELIZA_REQUIRE_LOCAL_AUTH",
    "ELIZA_DEV_AUTH_BYPASS",
    "ELIZA_CLOUD_PROVISIONED",
    "STEWARD_AGENT_TOKEN",
    "ELIZA_API_TOKEN",
    "ELIZAOS_CLOUD_ENABLED",
    "ELIZAOS_CLOUD_API_KEY",
    "NODE_ENV",
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  function req(headers: http.IncomingHttpHeaders): http.IncomingMessage {
    return {
      headers,
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as http.IncomingMessage;
  }

  it("trusts a bare loopback Host with no extra gates", () => {
    expect(isTrustedLocalRequest(req({ host: "localhost:2138" }))).toBe(true);
  });

  it("denies when ELIZA_REQUIRE_LOCAL_AUTH=1 is set", () => {
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
    expect(isTrustedLocalRequest(req({ host: "localhost:2138" }))).toBe(false);
  });

  it("rejects a spoofed X-Forwarded-For even on loopback", () => {
    expect(
      isTrustedLocalRequest(
        req({ host: "localhost:2138", "x-forwarded-for": "203.0.113.9" }),
      ),
    ).toBe(false);
  });
});

describe("readCompatJsonBody", () => {
  it("returns a pre-parsed object body without reading the stream", async () => {
    const payload = { hello: "world", n: 1 };
    const req = requestFromChunks([], { body: payload });
    const res = responseSink();
    await expect(readCompatJsonBody(req, res)).resolves.toBe(payload);
    expect(res.status()).toBe(200);
  });

  it("does not treat a pre-parsed array as a body (falls through to the stream)", async () => {
    const req = requestFromChunks([Buffer.from('{"ok":true}')], {
      body: [1, 2, 3],
    });
    const res = responseSink();
    await expect(readCompatJsonBody(req, res)).resolves.toEqual({ ok: true });
  });

  it("returns {} when the stream yields no chunks", async () => {
    const req = requestFromChunks([]);
    const res = responseSink();
    await expect(readCompatJsonBody(req, res)).resolves.toEqual({});
  });

  it("parses a streamed JSON object, including non-Buffer string chunks", async () => {
    const req = requestFromChunks(['{"a":', "1}"]);
    const res = responseSink();
    await expect(readCompatJsonBody(req, res)).resolves.toEqual({ a: 1 });
  });

  it.each(["[]", "null", '"foo"', "42", "true"])(
    "rejects non-object JSON %j with 400",
    async (raw) => {
      const req = requestFromChunks([Buffer.from(raw)]);
      const res = responseSink();
      await expect(readCompatJsonBody(req, res)).resolves.toBeNull();
      expect(res.status()).toBe(400);
      expect(res.jsonBody()).toEqual({ error: "Invalid JSON body" });
    },
  );

  it("rejects syntactically invalid JSON with 400", async () => {
    const req = requestFromChunks([Buffer.from("{")]);
    const res = responseSink();
    await expect(readCompatJsonBody(req, res)).resolves.toBeNull();
    expect(res.status()).toBe(400);
    expect(res.jsonBody()).toEqual({ error: "Invalid JSON body" });
  });

  it("returns 400 Invalid request body when the stream errors", async () => {
    const req = {
      headers: {},
      method: "POST",
      url: "/api/compat",
      socket: { remoteAddress: "127.0.0.1" },
      destroy() {},
      async *[Symbol.asyncIterator]() {
        yield Buffer.from("{");
        throw new Error("socket reset");
      },
    } as unknown as http.IncomingMessage;
    const res = responseSink();
    await expect(readCompatJsonBody(req, res)).resolves.toBeNull();
    expect(res.status()).toBe(400);
    expect(res.jsonBody()).toEqual({ error: "Invalid request body" });
  });

  it("accepts a body of exactly MAX_BODY_BYTES", async () => {
    const filler = "x".repeat(MAX_BODY_BYTES - 8);
    const raw = `{"k":"${filler}"}`;
    expect(Buffer.byteLength(raw)).toBe(MAX_BODY_BYTES);
    const req = requestFromChunks([Buffer.from(raw)]);
    const res = responseSink();
    const parsed = await readCompatJsonBody(req, res);
    expect(parsed).toEqual({ k: filler });
    expect(res.status()).toBe(200);
  });

  it("destroys the request and returns 413 when the body exceeds 1 MiB", async () => {
    const req = requestFromChunks([Buffer.alloc(MAX_BODY_BYTES + 1, 0x61)]);
    const res = responseSink();
    await expect(readCompatJsonBody(req, res)).resolves.toBeNull();
    expect(req.destroyedFlag).toBe(true);
    expect(res.status()).toBe(413);
    expect(res.jsonBody()).toEqual({ error: "Request body too large" });
  });
});

describe("hasCompatPersistedFirstRunState", () => {
  it("is false for an empty config", () => {
    expect(hasCompatPersistedFirstRunState({} as ElizaConfig)).toBe(false);
  });

  it("is true when meta.firstRunComplete is exactly true, and not for other truthy values", () => {
    expect(
      hasCompatPersistedFirstRunState({
        meta: { firstRunComplete: true },
      } as ElizaConfig),
    ).toBe(true);
    expect(
      hasCompatPersistedFirstRunState({
        meta: { firstRunComplete: false },
      } as ElizaConfig),
    ).toBe(false);
    expect(
      hasCompatPersistedFirstRunState({
        meta: { firstRunComplete: "true" as unknown as boolean },
      } as ElizaConfig),
    ).toBe(false);
  });

  it("is true for a local direct backend that is not elizacloud", () => {
    expect(
      hasCompatPersistedFirstRunState({
        serviceRouting: {
          llmText: { backend: "ollama", transport: "direct" },
        },
      } as ElizaConfig),
    ).toBe(true);
  });

  it("does not treat direct+elizacloud as complete canonical routing on its own", () => {
    expect(
      hasCompatPersistedFirstRunState({
        serviceRouting: {
          llmText: { backend: "elizacloud", transport: "direct" },
        },
      } as ElizaConfig),
    ).toBe(false);
  });

  it("is true for remote transport when a remoteApiBase is present", () => {
    expect(
      hasCompatPersistedFirstRunState({
        serviceRouting: {
          llmText: {
            backend: "remote",
            transport: "remote",
            remoteApiBase: "https://api.example.test",
          },
        },
      } as ElizaConfig),
    ).toBe(true);
  });

  it("is true for a remote deployment target with a remoteApiBase", () => {
    expect(
      hasCompatPersistedFirstRunState({
        deploymentTarget: {
          runtime: "remote",
          remoteApiBase: "https://eliza.example.test",
        },
      } as unknown as ElizaConfig),
    ).toBe(true);
  });

  it("is true for cloud-proxy elizacloud only when both model ids are non-blank", () => {
    expect(
      hasCompatPersistedFirstRunState({
        serviceRouting: {
          llmText: {
            backend: "elizacloud",
            transport: "cloud-proxy",
            smallModel: "grok-3",
            largeModel: "grok-4",
          },
        },
      } as ElizaConfig),
    ).toBe(true);
    expect(
      hasCompatPersistedFirstRunState({
        serviceRouting: {
          llmText: {
            backend: "elizacloud",
            transport: "cloud-proxy",
            smallModel: "   ",
            largeModel: "grok-4",
          },
        },
      } as ElizaConfig),
    ).toBe(false);
  });

  it("is true when agents.list is a non-empty array, even without names", () => {
    expect(
      hasCompatPersistedFirstRunState({
        agents: { list: [{}] },
      } as ElizaConfig),
    ).toBe(true);
    expect(
      hasCompatPersistedFirstRunState({
        agents: { list: [] },
      } as ElizaConfig),
    ).toBe(false);
  });

  it("is true when a trimmed default workspace or adminEntityId is set", () => {
    expect(
      hasCompatPersistedFirstRunState({
        agents: { defaults: { workspace: "  main  " } },
      } as ElizaConfig),
    ).toBe(true);
    expect(
      hasCompatPersistedFirstRunState({
        agents: { defaults: { adminEntityId: "owner-1" } },
      } as ElizaConfig),
    ).toBe(true);
    expect(
      hasCompatPersistedFirstRunState({
        agents: { defaults: { workspace: "   ", adminEntityId: "  " } },
      } as ElizaConfig),
    ).toBe(false);
  });
});

describe("getConfiguredCompatAgentName", () => {
  const ENV_KEYS = [
    "ELIZA_STATE_DIR",
    "ELIZA_CONFIG_PATH",
    "ELIZA_PERSIST_CONFIG_PATH",
  ] as const;
  const saved: Record<string, string | undefined> = {};
  let stateDir: string;
  let configPath: string;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-compat-agent-name-"),
    );
    configPath = path.join(stateDir, "eliza.json");
    process.env.ELIZA_STATE_DIR = stateDir;
    process.env.ELIZA_CONFIG_PATH = configPath;
    process.env.ELIZA_PERSIST_CONFIG_PATH = configPath;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function pinConfigEnv(): void {
    process.env.ELIZA_STATE_DIR = stateDir;
    process.env.ELIZA_CONFIG_PATH = configPath;
    process.env.ELIZA_PERSIST_CONFIG_PATH = configPath;
  }

  function writeConfig(config: ElizaConfig): void {
    pinConfigEnv();
    fs.writeFileSync(configPath, JSON.stringify(config));
    pinConfigEnv();
  }

  it("returns the trimmed first list-agent name when present", () => {
    writeConfig({
      agents: { list: [{ name: "  Ada  " }, { name: "Ignored" }] },
    } as ElizaConfig);
    expect(getConfiguredCompatAgentName()).toBe("Ada");
  });

  it("does not look past list[0] when that entry has no usable name", () => {
    writeConfig({
      agents: { list: [{ name: "   " }, { name: "Second" }] },
      ui: { assistant: { name: "Fallback" } },
    } as ElizaConfig);
    expect(getConfiguredCompatAgentName()).toBe("Fallback");
  });

  it("falls back to the trimmed UI assistant name", () => {
    writeConfig({
      ui: { assistant: { name: "  Sam  " } },
    } as ElizaConfig);
    expect(getConfiguredCompatAgentName()).toBe("Sam");
  });

  it("returns null when neither source has a non-empty string name", () => {
    writeConfig({
      agents: { list: [{ name: 12 as unknown as string }] },
      ui: { assistant: { name: "  " } },
    } as ElizaConfig);
    expect(getConfiguredCompatAgentName()).toBeNull();
  });

  it("returns null on a genuinely empty config", () => {
    expect(getConfiguredCompatAgentName()).toBeNull();
  });
});

describe("getCompatDrizzleDb", () => {
  it("returns null when there is no live runtime", () => {
    expect(getCompatDrizzleDb(emptyState())).toBeNull();
  });

  it("returns null when the runtime has no adapter or no db field", () => {
    expect(
      getCompatDrizzleDb({
        current: {} as CompatRuntimeState["current"],
        pendingAgentName: null,
        pendingRestartReasons: [],
      }),
    ).toBeNull();
    expect(
      getCompatDrizzleDb({
        current: { adapter: {} } as CompatRuntimeState["current"],
        pendingAgentName: null,
        pendingRestartReasons: [],
      }),
    ).toBeNull();
    expect(
      getCompatDrizzleDb({
        current: {
          adapter: { db: null },
        } as unknown as CompatRuntimeState["current"],
        pendingAgentName: null,
        pendingRestartReasons: [],
      }),
    ).toBeNull();
  });

  it("returns the adapter db handle when present", () => {
    const db = { execute: () => undefined };
    expect(
      getCompatDrizzleDb({
        current: {
          adapter: { db },
        } as unknown as CompatRuntimeState["current"],
        pendingAgentName: null,
        pendingRestartReasons: [],
      }),
    ).toBe(db);
  });
});
