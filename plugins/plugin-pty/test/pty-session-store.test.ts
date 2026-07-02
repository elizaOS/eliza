import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionOutputEvent } from "../services/pty-contract";
import {
  PtyConsoleBridge,
  PtySessionStore,
} from "../services/pty-session-store";
import type { PtySpawnSpec } from "../services/pty-types";
import { makeFakeSpawn } from "./fake-pty";

function makeStore(opts?: {
  allowedRoot?: string;
  maxSessions?: number;
  idleTimeoutMs?: number;
}) {
  const fake = makeFakeSpawn();
  const bridge = new PtyConsoleBridge();
  const store = new PtySessionStore(bridge, fake.resolver, opts);
  return { store, bridge, fake };
}

const spec = (over: Partial<PtySpawnSpec> = {}): PtySpawnSpec => ({
  command: "bun",
  args: ["/bin/eliza-code.js", "--interactive", "--coding-only"],
  cwd: "/work/repo",
  env: {
    ELIZA_CODE_CODING_ONLY: "1",
    OPENAI_API_KEY: "sk-1",
    TERM: "xterm-256color",
  },
  label: "eliza-code · fast",
  kind: "eliza-code",
  ...over,
});

const savedEnv = new Map<string, string | undefined>();

function setEnv(key: string, value: string): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  process.env[key] = value;
}

afterEach(() => {
  vi.useRealTimers();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

describe("PtySessionStore.start", () => {
  it("spawns with the spec's file/args and a minimal allowed env", async () => {
    const { store, fake } = makeStore();
    const info = await store.start(spec());
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call.file).toBe("bun");
    expect(call.args).toEqual([
      "/bin/eliza-code.js",
      "--interactive",
      "--coding-only",
    ]);
    expect(call.opts.cwd).toBe("/work/repo");
    expect(call.opts.env?.ELIZA_CODE_CODING_ONLY).toBe("1");
    expect(call.opts.env?.OPENAI_API_KEY).toBe("sk-1");
    expect(call.opts.env?.OPENAI_BASE_URL).toBeUndefined();
    expect(call.opts.env?.PWD).toBe("/work/repo");
    expect(call.opts.env?.TERM).toBe("xterm-256color");
    // A small safe process-env allowlist survives so the runner can start.
    expect(call.opts.env?.PATH ?? call.opts.env?.Path).toBeDefined();
    expect(call.opts.cols).toBe(120);
    expect(call.opts.rows).toBe(30);
    expect(info.sessionId).toMatch(/[0-9a-f-]{36}/);
    expect(info.pid).toBe(fake.ptys[0].pid);
    expect(info.exited).toBe(false);
  });

  it("does not inherit unrelated server process.env secrets", async () => {
    setEnv("AWS_SECRET_ACCESS_KEY", "aws-secret");
    setEnv("DATABASE_URL", "postgres://secret");
    setEnv("ELIZA_API_TOKEN", "api-secret");

    const { store, fake } = makeStore();
    await store.start(
      spec({
        env: {
          OPENAI_API_KEY: "sk-1",
          TERM: "xterm-256color",
          AWS_SECRET_ACCESS_KEY: "should-not-pass",
        },
      }),
    );

    const env = fake.calls[0].opts.env;
    expect(env?.OPENAI_API_KEY).toBe("sk-1");
    expect(env?.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env?.DATABASE_URL).toBeUndefined();
    expect(env?.ELIZA_API_TOKEN).toBeUndefined();
  });

  it("allows the vendor-CLI credential handles through the spec-env allowlist", async () => {
    const { store, fake } = makeStore();
    await store.start(
      spec({
        env: {
          CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-1",
          CODEX_HOME: "/accounts/codex-a1",
          NOT_ALLOWLISTED: "dropped",
        },
      }),
    );

    const env = fake.calls[0].opts.env;
    expect(env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-1");
    expect(env?.CODEX_HOME).toBe("/accounts/codex-a1");
    expect(env?.NOT_ALLOWLISTED).toBeUndefined();
  });

  it("streams PTY output through the bridge as session_output {sessionId,data}", async () => {
    const { store, bridge, fake } = makeStore();
    const events: SessionOutputEvent[] = [];
    bridge.on("session_output", (e) => events.push(e as SessionOutputEvent));
    const info = await store.start(spec());
    fake.ptys[0].emitData("hello ");
    fake.ptys[0].emitData("world");
    expect(events).toEqual([
      { sessionId: info.sessionId, data: "hello " },
      { sessionId: info.sessionId, data: "world" },
    ]);
  });

  it("buffers PTY output for clients that subscribe after spawn", async () => {
    const { store, bridge, fake } = makeStore();
    const info = await store.start(spec());
    fake.ptys[0].emitData("prompt> ");
    expect(store.getBufferedOutput(info.sessionId)).toBe("prompt> ");

    const events: SessionOutputEvent[] = [];
    bridge.on("session_output", (e) => events.push(e as SessionOutputEvent));
    fake.ptys[0].emitData("after-subscribe");
    expect(events).toEqual([
      { sessionId: info.sessionId, data: "after-subscribe" },
    ]);
    expect(store.getBufferedOutput(info.sessionId)).toBe(
      "prompt> after-subscribe",
    );
  });

  it("keeps sessions isolated — output carries the right sessionId", async () => {
    const { store, bridge, fake } = makeStore();
    const seen: SessionOutputEvent[] = [];
    bridge.on("session_output", (e) => seen.push(e as SessionOutputEvent));
    const a = await store.start(spec({ label: "a" }));
    const b = await store.start(spec({ label: "b" }));
    fake.ptys[1].emitData("from-b");
    fake.ptys[0].emitData("from-a");
    expect(seen).toEqual([
      { sessionId: b.sessionId, data: "from-b" },
      { sessionId: a.sessionId, data: "from-a" },
    ]);
  });

  it("enforces the concurrent-session cap", async () => {
    const { store } = makeStore({ maxSessions: 1 });
    await store.start(spec());
    await expect(store.start(spec())).rejects.toThrow(/session limit/i);
  });

  it("confines cwd to the allowed root", async () => {
    const { store, fake } = makeStore({ allowedRoot: "/work" });
    await store.start(spec({ cwd: "/work/repo/sub" })); // ok
    expect(fake.calls).toHaveLength(1);
    await expect(store.start(spec({ cwd: "/etc" }))).rejects.toThrow(
      /outside the allowed root/i,
    );
  });
});

describe("PtyConsoleBridge routing", () => {
  it("writeRaw forwards keystrokes to the matching PTY only", async () => {
    const { store, bridge, fake } = makeStore();
    const a = await store.start(spec());
    const b = await store.start(spec());
    bridge.writeRaw(a.sessionId, "ls\r");
    expect(fake.ptys[0].written).toEqual(["ls\r"]);
    expect(fake.ptys[1].written).toEqual([]);
    bridge.writeRaw(b.sessionId, "/help\r");
    expect(fake.ptys[1].written).toEqual(["/help\r"]);
  });

  it("writeRaw to an unknown or exited session is a no-op", async () => {
    const { store, bridge, fake } = makeStore();
    const a = await store.start(spec());
    bridge.writeRaw("does-not-exist", "x");
    fake.ptys[0].emitExit(0);
    bridge.writeRaw(a.sessionId, "after-exit");
    expect(fake.ptys[0].written).toEqual([]);
  });

  it("resize forwards valid geometry and ignores degenerate values", async () => {
    const { store, bridge, fake } = makeStore();
    const a = await store.start(spec());
    bridge.resize(a.sessionId, 100, 40);
    bridge.resize(a.sessionId, 0, 40); // ignored
    bridge.resize(a.sessionId, Number.NaN, 10); // ignored
    bridge.resize(a.sessionId, 80.9, 24.9); // floored
    expect(fake.ptys[0].resized).toEqual([
      [100, 40],
      [80, 24],
    ]);
  });
});

describe("PtySessionStore lifecycle", () => {
  it("exit marks the session exited and emits session_exit", async () => {
    const { store, bridge, fake } = makeStore();
    const exits: Array<{ sessionId: string; exitCode: number | null }> = [];
    bridge.on("session_exit", (e) =>
      exits.push(e as { sessionId: string; exitCode: number | null }),
    );
    const a = await store.start(spec());
    fake.ptys[0].emitExit(3);
    expect(exits).toEqual([{ sessionId: a.sessionId, exitCode: 3 }]);
    expect(store.list().find((s) => s.sessionId === a.sessionId)?.exited).toBe(
      true,
    );
  });

  it("stop kills the PTY and removes the record", async () => {
    const { store, fake } = makeStore();
    const a = await store.start(spec());
    expect(store.size).toBe(1);
    await store.stop(a.sessionId);
    expect(fake.ptys[0].killed).toBe(true);
    expect(store.has(a.sessionId)).toBe(false);
    expect(store.size).toBe(0);
  });

  it("stopAll kills every session", async () => {
    const { store, fake } = makeStore();
    await store.start(spec());
    await store.start(spec());
    await store.stopAll();
    expect(fake.ptys.every((p) => p.killed)).toBe(true);
    expect(store.size).toBe(0);
  });

  it("stops live sessions that exceed the idle timeout", async () => {
    vi.useFakeTimers();
    const { store, fake } = makeStore({ idleTimeoutMs: 100 });
    const a = await store.start(spec());
    expect(store.has(a.sessionId)).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.ptys[0].killed).toBe(true);
    expect(store.has(a.sessionId)).toBe(false);
  });

  it("list() returns serializable info without leaking the PTY handle", async () => {
    const { store } = makeStore();
    const a = await store.start(spec());
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      sessionId: a.sessionId,
      command: "bun",
      kind: "eliza-code",
      exited: false,
    });
    expect(Object.keys(list[0])).not.toContain("pty");
  });
});
