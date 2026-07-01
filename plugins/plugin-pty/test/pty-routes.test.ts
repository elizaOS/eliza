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
  return { runtime, svc, calls: fake.calls };
}

function ctx(
  runtime: IAgentRuntime,
  body?: unknown,
  params?: Record<string, string>,
) {
  return {
    body,
    params: params ?? {},
    query: {},
    headers: {},
    method: "POST",
    path: "/api/pty/sessions",
    runtime,
    inProcess: true,
  };
}

// Keep the eliza-code bin resolution deterministic + isolate API-key env.
let savedBin: string | undefined;
let savedKey: string | undefined;
beforeEach(() => {
  savedBin = process.env.ELIZA_CODE_BIN;
  savedKey = process.env.OPENAI_API_KEY;
  process.env.ELIZA_CODE_BIN = EXISTING_FILE;
  delete process.env.OPENAI_API_KEY;
});
afterEach(() => {
  if (savedBin === undefined) delete process.env.ELIZA_CODE_BIN;
  else process.env.ELIZA_CODE_BIN = savedBin;
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
});

describe("POST /api/pty/sessions", () => {
  it("spawns an interactive eliza-code session and returns its id", async () => {
    const h = makeHarness({ settings: { OPENAI_API_KEY: "sk-cloud" } });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { kind: "eliza-code", cwd: process.cwd(), tier: "smart" }),
    );
    expect(res.status).toBe(200);
    const session = (res.body as { session: { sessionId: string } }).session;
    expect(session.sessionId).toMatch(/[0-9a-f-]{36}/);
    // Real spawn wiring: bun runs the interactive bin with cerebras env.
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].file).toBe("bun");
    expect(h.calls[0].args).toEqual([EXISTING_FILE, "--interactive"]);
    expect(h.calls[0].opts.env?.OPENAI_API_KEY).toBe("sk-cloud");
    expect(h.calls[0].opts.env?.OPENAI_SMALL_MODEL).toBe("zai-glm-4.7"); // smart tier
  });

  it("403 when interactive spawning is disabled", async () => {
    const h = makeHarness({
      settings: { OPENAI_API_KEY: "sk", PTY_INTERACTIVE_ENABLED: "false" },
    });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { cwd: process.cwd() }),
    );
    expect(res.status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  it("403 on store builds", async () => {
    const h = makeHarness({
      settings: { OPENAI_API_KEY: "sk", ELIZA_BUILD_VARIANT: "store" },
    });
    const res = await routeByName("pty-spawn-session")(ctx(h.runtime, {}));
    expect(res.status).toBe(403);
  });

  it("503 when PTY_SERVICE is not registered", async () => {
    const h = makeHarness({
      noService: true,
      settings: { OPENAI_API_KEY: "sk" },
    });
    const res = await routeByName("pty-spawn-session")(ctx(h.runtime, {}));
    expect(res.status).toBe(503);
  });

  it("400 on an unsupported session kind", async () => {
    const h = makeHarness({ settings: { OPENAI_API_KEY: "sk" } });
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

  it("accepts an apiKey supplied in the body", async () => {
    const h = makeHarness({ settings: {} });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { apiKey: "sk-body", cwd: process.cwd() }),
    );
    expect(res.status).toBe(200);
    expect(h.calls[0].opts.env?.OPENAI_API_KEY).toBe("sk-body");
  });
});

describe("GET + DELETE /api/pty/sessions", () => {
  it("lists live sessions", async () => {
    const h = makeHarness({ settings: { OPENAI_API_KEY: "sk" } });
    await routeByName("pty-spawn-session")(
      ctx(h.runtime, { cwd: process.cwd() }),
    );
    const res = await routeByName("pty-list-sessions")(ctx(h.runtime));
    expect(res.status).toBe(200);
    expect((res.body as { sessions: unknown[] }).sessions).toHaveLength(1);
  });

  it("stops a session by id", async () => {
    const h = makeHarness({ settings: { OPENAI_API_KEY: "sk" } });
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
    const h = makeHarness({ settings: { OPENAI_API_KEY: "sk" } });
    const res = await routeByName("pty-stop-session")(
      ctx(h.runtime, undefined, {}),
    );
    expect(res.status).toBe(400);
  });
});
