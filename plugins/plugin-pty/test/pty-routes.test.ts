import { fileURLToPath } from "node:url";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ptyRoutes } from "../routes/pty-routes";
import { PtyService } from "../services/pty-service";
import { makeFakeSpawn, type SpawnCall } from "./fake-pty";

// A real file that always exists, so resolveElizaCodeBin() succeeds in tests.
const EXISTING_FILE = fileURLToPath(import.meta.url);

const routeByName = (name: string) => {
  const r = ptyRoutes.find((x) => x.name === name);
  if (!r?.routeHandler) throw new Error(`route ${name} missing`);
  return r.routeHandler;
};

interface Harness {
  runtime: IAgentRuntime;
  svc: PtyService | null;
  calls: SpawnCall[];
  fake: ReturnType<typeof makeFakeSpawn>;
}

function makeHarness(opts?: {
  settings?: Record<string, string>;
  noService?: boolean;
}): Harness {
  const fake = makeFakeSpawn();
  const svc = opts?.noService
    ? null
    : new PtyService(undefined, fake.resolver, { allowedRoot: process.cwd() });
  const settings = opts?.settings ?? {};
  const runtime = {
    getSetting: (k: string) => settings[k],
    getService: (t: string) => (t === "PTY_SERVICE" ? svc : null),
  } as unknown as IAgentRuntime;
  return { runtime, svc, calls: fake.calls, fake };
}

function ctx(
  runtime: IAgentRuntime,
  body?: unknown,
  params?: Record<string, string>,
  opts?: {
    headers?: Record<string, string>;
    query?: Record<string, string>;
    inProcess?: boolean;
    isTrustedLocal?: boolean;
  },
) {
  return {
    body,
    params: params ?? {},
    query: opts?.query ?? {},
    headers: opts?.headers ?? {},
    method: "POST",
    path: "/api/pty/sessions",
    runtime,
    inProcess: opts?.inProcess ?? true,
    isTrustedLocal: opts?.isTrustedLocal ?? false,
  };
}

// Keep the eliza-code bin resolution deterministic + isolate API-key env.
let savedBin: string | undefined;
let savedKey: string | undefined;
beforeEach(() => {
  savedBin = process.env.ELIZA_CODE_BIN;
  savedKey = process.env.PTY_ELIZA_CLOUD_API_KEY;
  process.env.ELIZA_CODE_BIN = EXISTING_FILE;
  delete process.env.PTY_ELIZA_CLOUD_API_KEY;
});
afterEach(() => {
  if (savedBin === undefined) delete process.env.ELIZA_CODE_BIN;
  else process.env.ELIZA_CODE_BIN = savedBin;
  if (savedKey === undefined) delete process.env.PTY_ELIZA_CLOUD_API_KEY;
  else process.env.PTY_ELIZA_CLOUD_API_KEY = savedKey;
});

describe("POST /api/pty/sessions", () => {
  it("403s HTTP callers when no terminal token is configured", async () => {
    const h = makeHarness({
      settings: { PTY_ELIZA_CLOUD_API_KEY: "sk-cloud" },
    });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { kind: "eliza-code", cwd: process.cwd() }, undefined, {
        inProcess: false,
      }),
    );
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/terminal token/i);
    expect(h.calls).toHaveLength(0);
  });

  it("accepts trusted local HTTP cockpit callers without exposing a terminal token", async () => {
    const h = makeHarness({
      settings: {
        PTY_ELIZA_CLOUD_API_KEY: "sk-cloud",
        ELIZA_TERMINAL_RUN_TOKEN: "pty-secret",
      },
    });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { kind: "eliza-code", cwd: process.cwd() }, undefined, {
        headers: { "x-elizaos-client-id": "client-1" },
        inProcess: false,
        isTrustedLocal: true,
      }),
    );
    expect(res.status).toBe(200);
    expect(h.calls).toHaveLength(1);
    const session = (res.body as { session: { ownerClientId?: string } })
      .session;
    expect(session.ownerClientId).toBe("client-1");
  });

  it("401s HTTP callers that omit a configured terminal token", async () => {
    const h = makeHarness({
      settings: {
        PTY_ELIZA_CLOUD_API_KEY: "sk-cloud",
        ELIZA_TERMINAL_RUN_TOKEN: "pty-secret",
      },
    });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { kind: "eliza-code", cwd: process.cwd() }, undefined, {
        inProcess: false,
      }),
    );
    expect(res.status).toBe(401);
    expect((res.body as { error: string }).error).toMatch(/missing/i);
    expect(h.calls).toHaveLength(0);
  });

  it("401s HTTP callers with an invalid terminal token", async () => {
    const h = makeHarness({
      settings: {
        PTY_ELIZA_CLOUD_API_KEY: "sk-cloud",
        ELIZA_TERMINAL_RUN_TOKEN: "pty-secret",
      },
    });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { kind: "eliza-code", cwd: process.cwd() }, undefined, {
        headers: { "x-eliza-terminal-token": "wrong" },
        inProcess: false,
      }),
    );
    expect(res.status).toBe(401);
    expect((res.body as { error: string }).error).toMatch(/invalid/i);
    expect(h.calls).toHaveLength(0);
  });

  it("accepts HTTP callers with the configured terminal token", async () => {
    const h = makeHarness({
      settings: {
        PTY_ELIZA_CLOUD_API_KEY: "sk-cloud",
        ELIZA_TERMINAL_RUN_TOKEN: "pty-secret",
      },
    });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { kind: "eliza-code", cwd: process.cwd() }, undefined, {
        headers: { "x-eliza-terminal-token": "pty-secret" },
        inProcess: false,
      }),
    );
    expect(res.status).toBe(200);
    expect(h.calls).toHaveLength(1);
  });

  it("spawns an interactive eliza-code session and returns its id", async () => {
    const h = makeHarness({
      settings: { PTY_ELIZA_CLOUD_API_KEY: "sk-cloud" },
    });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { kind: "eliza-code", cwd: process.cwd(), tier: "smart" }),
    );
    expect(res.status).toBe(200);
    const session = (res.body as { session: { sessionId: string } }).session;
    expect(session.sessionId).toMatch(/[0-9a-f-]{36}/);
    // Real spawn wiring: bun runs the interactive bin with cerebras env.
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].file).toBe("bun");
    expect(h.calls[0].args).toEqual([
      EXISTING_FILE,
      "--interactive",
      "--coding-only",
    ]);
    expect(h.calls[0].opts.env?.ELIZA_CODE_CODING_ONLY).toBe("1");
    expect(h.calls[0].opts.env?.OPENAI_API_KEY).toBe("sk-cloud");
    expect(h.calls[0].opts.env?.OPENAI_SMALL_MODEL).toBe("gemma-4-31b");
  });

  it("403 when interactive spawning is disabled", async () => {
    const h = makeHarness({
      settings: {
        PTY_ELIZA_CLOUD_API_KEY: "sk",
        PTY_INTERACTIVE_ENABLED: "false",
      },
    });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { cwd: process.cwd() }),
    );
    expect(res.status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  it("403s for explicit non-truthy interactive settings", async () => {
    for (const value of [" FALSE ", "off", "no", "disable-please"]) {
      const h = makeHarness({
        settings: {
          PTY_ELIZA_CLOUD_API_KEY: "sk",
          PTY_INTERACTIVE_ENABLED: value,
        },
      });
      const res = await routeByName("pty-spawn-session")(
        ctx(h.runtime, { cwd: process.cwd() }),
      );
      expect(res.status, value).toBe(403);
      expect(h.calls, value).toHaveLength(0);
    }
  });

  it("accepts explicit truthy interactive settings", async () => {
    for (const value of ["true", "1", "on", "YES"]) {
      const h = makeHarness({
        settings: {
          PTY_ELIZA_CLOUD_API_KEY: "sk",
          PTY_INTERACTIVE_ENABLED: value,
        },
      });
      const res = await routeByName("pty-spawn-session")(
        ctx(h.runtime, { cwd: process.cwd() }),
      );
      expect(res.status, value).toBe(200);
      expect(h.calls, value).toHaveLength(1);
    }
  });

  it("403 on store builds", async () => {
    const h = makeHarness({
      settings: {
        PTY_ELIZA_CLOUD_API_KEY: "sk",
        ELIZA_BUILD_VARIANT: "store",
      },
    });
    const res = await routeByName("pty-spawn-session")(ctx(h.runtime, {}));
    expect(res.status).toBe(403);
  });

  it("503 when PTY_SERVICE is not registered", async () => {
    const h = makeHarness({
      noService: true,
      settings: { PTY_ELIZA_CLOUD_API_KEY: "sk" },
    });
    const res = await routeByName("pty-spawn-session")(ctx(h.runtime, {}));
    expect(res.status).toBe(503);
  });

  it("400 on an unsupported session kind", async () => {
    const h = makeHarness({ settings: { PTY_ELIZA_CLOUD_API_KEY: "sk" } });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { kind: "claude" }),
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/unsupported/i);
  });

  it("400 when no Eliza Cloud API key is available", async () => {
    const h = makeHarness({ settings: {} }); // no key anywhere
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { cwd: process.cwd() }),
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/api key/i);
  });

  it("does not fall back to the agent primary OPENAI_API_KEY", async () => {
    const h = makeHarness({ settings: { OPENAI_API_KEY: "sk-primary" } });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { cwd: process.cwd() }),
    );
    expect(res.status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });

  it("accepts an apiKey supplied in the body", async () => {
    const h = makeHarness({ settings: {} });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { apiKey: "sk-body", cwd: process.cwd() }),
    );
    expect(res.status).toBe(200);
    expect(h.calls[0].opts.env?.OPENAI_API_KEY).toBe("sk-body");
  });

  it("uses operator-pinned tier model fallbacks", async () => {
    const h = makeHarness({
      settings: {
        PTY_ELIZA_CLOUD_API_KEY: "sk",
        PTY_ELIZA_CLOUD_FAST_MODEL: "fast-pin",
        PTY_ELIZA_CLOUD_SMART_MODEL: "smart-pin",
      },
    });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { cwd: process.cwd() }),
    );
    expect(res.status).toBe(200);
    expect(h.calls[0].opts.env?.OPENAI_SMALL_MODEL).toBe("fast-pin");
    expect(h.calls[0].opts.env?.OPENAI_MEDIUM_MODEL).toBe("fast-pin");
    expect(h.calls[0].opts.env?.OPENAI_LARGE_MODEL).toBe("smart-pin");
  });

  it("lets request body tier models override operator fallbacks", async () => {
    const h = makeHarness({
      settings: {
        PTY_ELIZA_CLOUD_API_KEY: "sk",
        PTY_ELIZA_CLOUD_FAST_MODEL: "fast-pin",
        PTY_ELIZA_CLOUD_SMART_MODEL: "smart-pin",
      },
    });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, {
        cwd: process.cwd(),
        fastModel: "fast-body",
        smartModel: "smart-body",
      }),
    );
    expect(res.status).toBe(200);
    expect(h.calls[0].opts.env?.OPENAI_SMALL_MODEL).toBe("fast-body");
    expect(h.calls[0].opts.env?.OPENAI_MEDIUM_MODEL).toBe("fast-body");
    expect(h.calls[0].opts.env?.OPENAI_LARGE_MODEL).toBe("smart-body");
  });

  it("rejects unallowlisted base URLs and accepts explicit operator allowlist", async () => {
    const rejected = makeHarness({
      settings: { PTY_ELIZA_CLOUD_API_KEY: "sk" },
    });
    const blocked = await routeByName("pty-spawn-session")(
      ctx(rejected.runtime, {
        cwd: process.cwd(),
        baseUrl: "https://attacker.example/v1",
      }),
    );
    expect(blocked.status).toBe(400);
    expect((blocked.body as { error: string }).error).toMatch(/baseUrl/i);
    expect(rejected.calls).toHaveLength(0);

    const allowed = makeHarness({
      settings: {
        PTY_ELIZA_CLOUD_API_KEY: "sk",
        PTY_ALLOWED_BASE_URLS: "https://staging.example/v1",
      },
    });
    const ok = await routeByName("pty-spawn-session")(
      ctx(allowed.runtime, {
        cwd: process.cwd(),
        baseUrl: "https://staging.example/v1/",
      }),
    );
    expect(ok.status).toBe(200);
    expect(allowed.calls[0].opts.env?.OPENAI_BASE_URL).toBe(
      "https://staging.example/v1",
    );
  });
});

describe("GET + DELETE /api/pty/sessions", () => {
  it("requires terminal authorization to list or stop sessions over HTTP", async () => {
    const h = makeHarness({
      settings: {
        OPENAI_API_KEY: "sk",
        PTY_ELIZA_CLOUD_API_KEY: "sk",
        ELIZA_TERMINAL_RUN_TOKEN: "pty-secret",
      },
    });
    const spawn = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { cwd: process.cwd() }, undefined, {
        headers: { "x-eliza-terminal-token": "pty-secret" },
        inProcess: false,
      }),
    );
    const id = (spawn.body as { session: { sessionId: string } }).session
      .sessionId;

    const list = await routeByName("pty-list-sessions")(
      ctx(h.runtime, undefined, undefined, { inProcess: false }),
    );
    expect(list.status).toBe(401);

    const stop = await routeByName("pty-stop-session")(
      ctx(h.runtime, undefined, { id }, { inProcess: false }),
    );
    expect(stop.status).toBe(401);
    expect(h.svc?.hasSession(id)).toBe(true);
  });

  it("lists live sessions", async () => {
    const h = makeHarness({ settings: { PTY_ELIZA_CLOUD_API_KEY: "sk" } });
    await routeByName("pty-spawn-session")(
      ctx(h.runtime, { cwd: process.cwd() }),
    );
    const res = await routeByName("pty-list-sessions")(ctx(h.runtime));
    expect(res.status).toBe(200);
    expect((res.body as { sessions: unknown[] }).sessions).toHaveLength(1);
  });

  it("returns buffered output for a live session", async () => {
    const h = makeHarness({ settings: { PTY_ELIZA_CLOUD_API_KEY: "sk" } });
    const spawn = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { cwd: process.cwd() }),
    );
    const id = (spawn.body as { session: { sessionId: string } }).session
      .sessionId;
    h.fake.ptys[0].emitData("ready> ");

    const res = await routeByName("pty-buffered-output")(
      ctx(h.runtime, undefined, { id }),
    );
    expect(res.status).toBe(200);
    expect((res.body as { output: string }).output).toBe("ready> ");
  });

  it("404s buffered output for an unknown session so clients can fall back", async () => {
    const h = makeHarness({ settings: { PTY_ELIZA_CLOUD_API_KEY: "sk" } });
    const res = await routeByName("pty-buffered-output")(
      ctx(h.runtime, undefined, { id: "missing" }),
    );
    expect(res.status).toBe(404);
  });

  it("stops a session by id", async () => {
    const h = makeHarness({ settings: { PTY_ELIZA_CLOUD_API_KEY: "sk" } });
    const spawn = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { cwd: process.cwd() }),
    );
    const id = (spawn.body as { session: { sessionId: string } }).session
      .sessionId;
    const res = await routeByName("pty-stop-session")(
      ctx(h.runtime, undefined, { id }),
    );
    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
    expect(h.svc?.hasSession(id)).toBe(false);
  });

  it("400 when stopping without an id", async () => {
    const h = makeHarness({ settings: { PTY_ELIZA_CLOUD_API_KEY: "sk" } });
    const res = await routeByName("pty-stop-session")(
      ctx(h.runtime, undefined, {}),
    );
    expect(res.status).toBe(400);
  });
});
