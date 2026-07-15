/**
 * Unit and opportunistic real-binary tests for the CLI inference route: the
 * `ELIZA_CHAT_VIA_CLI` auto-enable gate, backend resolution, the large-tier
 * model map and registration metadata, and the claude/codex spawn plus
 * JSONL-parse and prompt-flatten paths. The child-process spawn seam is mocked
 * so no real model runs; the few real-binary cases are skipped unless
 * `claude`/`codex` resolve through the SOC2 allowlist on this box.
 */
import type { ChatMessage, IAgentRuntime, PluginAutoEnableContext } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldEnable } from "../auto-enable";
import {
  buildModelMetadata,
  buildModels,
  ClaudeCli,
  ClaudeSdkSession,
  CodexSdkSession,
  cliInferencePlugin,
  LARGE_TIER_MODEL_TYPES,
  resolveCliBackend,
  resolveSdkEffort,
} from "../index";
import {
  __setSpawnForTests as __setClaudeSpawn,
  defaultSpawn,
  type SpawnOptions,
  type SpawnResult,
} from "../src/claude-cli";
import { normalizeEffort } from "../src/claude-sdk-session";
import {
  __setSpawnForTests as __setCodexSpawn,
  CodexCli,
  parseCodexJsonl,
} from "../src/codex-cli-exec";
import { flattenPrompt } from "../src/prompt-flatten";
import { resolveSafeBinary } from "../src/sandbox";

/**
 * True iff `bin` resolves THROUGH THE SOC2 ALLOWLIST on this box (gates the
 * real-binary tests). Must probe via `resolveSafeBinary` — not the full `$PATH`
 * — because a `claude`/`codex` install on `$PATH` but outside the allowlist (the
 * common CI case) would otherwise leave the test un-skipped and then throw.
 */
function binaryOnPath(bin: string): boolean {
  try {
    resolveSafeBinary(bin);
    return true;
  } catch {
    return false;
  }
}

function autoEnableCtx(env: Record<string, string | undefined>): PluginAutoEnableContext {
  return { env } as unknown as PluginAutoEnableContext;
}

// Pin fake binary paths so the SOC2 `resolveSafeBinary` allowlist check never
// touches the real filesystem (the real claude/codex symlinks resolve outside
// the whitelist on dev boxes). The spawn itself is fully mocked.
const FAKE_CLAUDE = "/usr/local/bin/claude";
const FAKE_CODEX = "/usr/local/bin/codex";

interface Captured {
  argv: string[];
  opts: SpawnOptions;
}

/** A mock spawner that records the call and returns a canned result. */
function recordingSpawn(result: Partial<SpawnResult>) {
  const calls: Captured[] = [];
  const fn = async (argv: string[], opts: SpawnOptions): Promise<SpawnResult> => {
    calls.push({ argv, opts });
    return {
      code: result.code ?? 0,
      signal: result.signal ?? null,
      stdout: result.stdout ?? "ok",
      stderr: result.stderr ?? "",
      timedOut: result.timedOut ?? false,
    };
  };
  return { calls, fn };
}

afterEach(() => {
  delete process.env.ELIZA_CHAT_VIA_CLI;
  delete process.env.ELIZA_PLANNER_NATIVE_TOOLS;
  delete process.env.ELIZA_ENABLE_CLAUDE_STEALTH;
  vi.restoreAllMocks();
});

describe("flattenPrompt", () => {
  it("routes system/developer messages to the system slot and others to the body, dropping nothing", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "be terse" },
      { role: "user", content: "what is 2+2?" },
      { role: "assistant", content: "4" },
      { role: "developer", content: "use the grammar" },
      { role: "user", content: "and 3+3?" },
    ];
    const { system, body } = flattenPrompt({ system: "ROOT", messages });
    expect(system).toContain("ROOT");
    expect(system).toContain("be terse");
    expect(system).toContain("use the grammar");
    expect(body).toContain("what is 2+2?");
    expect(body).toContain("4");
    expect(body).toContain("and 3+3?");
    // none of the user/assistant content was dropped
    expect(body).toMatch(/User:/);
    expect(body).toMatch(/Assistant:/);
  });

  it("appends a legacy prompt that is not already the message tail", () => {
    const { body } = flattenPrompt({
      messages: [{ role: "user", content: "first" }],
      prompt: "second",
    });
    expect(body).toContain("first");
    expect(body).toContain("second");
  });
});

describe("claude CLI variant", () => {
  it("assembles argv: -p<body>, --system-prompt<verbatim>, --output-format text, --model; stdin /dev/null; isolated cwd", async () => {
    const { calls, fn } = recordingSpawn({ stdout: "hello world\n" });
    const restore = __setClaudeSpawn(fn);
    try {
      const cli = new ClaudeCli({
        model: "claude-opus-4-8",
        env: { PATH: process.env.PATH },
        binaryPath: FAKE_CLAUDE,
      });
      const out = await cli.generate({
        system: "SYSTEM PROMPT VERBATIM",
        messages: [{ role: "user", content: "hi there" }],
      });
      expect(out).toBe("hello world");
      expect(calls).toHaveLength(1);
      const { argv, opts } = calls[0];

      // -p carries the flattened body (the messages)
      const pIdx = argv.indexOf("-p");
      expect(pIdx).toBeGreaterThanOrEqual(0);
      expect(argv[pIdx + 1]).toContain("hi there");

      // --system-prompt carries the system VERBATIM (full replace)
      const sysIdx = argv.indexOf("--system-prompt");
      expect(sysIdx).toBeGreaterThanOrEqual(0);
      expect(argv[sysIdx + 1]).toBe("SYSTEM PROMPT VERBATIM");

      // output format + model + dynamic-section suppression
      const ofIdx = argv.indexOf("--output-format");
      expect(argv[ofIdx + 1]).toBe("text");
      expect(argv).toContain("--exclude-dynamic-system-prompt-sections");
      const mIdx = argv.indexOf("--model");
      expect(argv[mIdx + 1]).toBe("claude-opus-4-8");

      // stdin from /dev/null, isolated tmpdir cwd
      expect(opts.stdinPath).toBe("/dev/null");
      expect(opts.cwd).toContain("eliza-cli-inference-");
    } finally {
      restore();
    }
  });

  it("never forwards the subscription token to the child env", async () => {
    const { calls, fn } = recordingSpawn({ stdout: "ok" });
    const restore = __setClaudeSpawn(fn);
    try {
      const cli = new ClaudeCli({
        binaryPath: FAKE_CLAUDE,
        env: {
          PATH: process.env.PATH,
          HOME: "/home/test",
          ANTHROPIC_API_KEY: "sk-ant-SHOULD-NOT-LEAK",
          CLAUDE_CODE_OAUTH_TOKEN: "oat-SHOULD-NOT-LEAK",
        },
      });
      await cli.generate({ prompt: "hi" });
      const { opts } = calls[0];
      expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(JSON.stringify(opts.env)).not.toContain("SHOULD-NOT-LEAK");
      // allowlisted, non-sensitive keys survive
      expect(opts.env.HOME).toBe("/home/test");
    } finally {
      restore();
    }
  });

  it("threads system+user+assistant messages: system -> --system-prompt, rest -> body, none dropped", async () => {
    const { calls, fn } = recordingSpawn({ stdout: "answer" });
    const restore = __setClaudeSpawn(fn);
    try {
      const cli = new ClaudeCli({ env: { PATH: process.env.PATH }, binaryPath: FAKE_CLAUDE });
      await cli.generate({
        messages: [
          { role: "system", content: "SYS-A" },
          { role: "user", content: "USER-A" },
          { role: "assistant", content: "ASSIST-A" },
          { role: "user", content: "USER-B" },
        ],
      });
      const { argv } = calls[0];
      const system = argv[argv.indexOf("--system-prompt") + 1];
      const body = argv[argv.indexOf("-p") + 1];
      expect(system).toContain("SYS-A");
      expect(body).toContain("USER-A");
      expect(body).toContain("ASSIST-A");
      expect(body).toContain("USER-B");
    } finally {
      restore();
    }
  });

  it("returns trimmed stdout", async () => {
    const { fn } = recordingSpawn({ stdout: "  ok  \n" });
    const restore = __setClaudeSpawn(fn);
    try {
      const cli = new ClaudeCli({ env: { PATH: process.env.PATH }, binaryPath: FAKE_CLAUDE });
      expect(await cli.generate({ prompt: "x" })).toBe("ok");
    } finally {
      restore();
    }
  });

  it("THROWS on non-zero exit, with redacted stderr", async () => {
    const { fn } = recordingSpawn({
      code: 1,
      stdout: "",
      stderr: "boom\nANTHROPIC_API_KEY=sk-ant-leak\nmore",
    });
    const restore = __setClaudeSpawn(fn);
    try {
      const cli = new ClaudeCli({ env: { PATH: process.env.PATH }, binaryPath: FAKE_CLAUDE });
      await expect(cli.generate({ prompt: "x" })).rejects.toThrow(/exited 1/);
      await expect(cli.generate({ prompt: "x" })).rejects.not.toThrow(/sk-ant-leak/);
    } finally {
      restore();
    }
  });

  it("THROWS on timeout (SIGTERM)", async () => {
    const { fn } = recordingSpawn({ code: null, signal: "SIGTERM", stdout: "", timedOut: true });
    const restore = __setClaudeSpawn(fn);
    try {
      const cli = new ClaudeCli({
        env: { PATH: process.env.PATH },
        timeoutMs: 50,
        binaryPath: FAKE_CLAUDE,
      });
      await expect(cli.generate({ prompt: "x" })).rejects.toThrow(/timed out/);
    } finally {
      restore();
    }
  });

  it("THROWS on empty stdout", async () => {
    const { fn } = recordingSpawn({ code: 0, stdout: "   \n  " });
    const restore = __setClaudeSpawn(fn);
    try {
      const cli = new ClaudeCli({ env: { PATH: process.env.PATH }, binaryPath: FAKE_CLAUDE });
      await expect(cli.generate({ prompt: "x" })).rejects.toThrow(/empty stdout/);
    } finally {
      restore();
    }
  });
});

describe("codex CLI variant", () => {
  it("assembles argv: exec / -m / -s read-only / --skip-git-repo-check / -C / --color never / --json", async () => {
    const jsonl = `{"type":"item.completed","item":{"type":"agent_message","text":"codex says hi"}}\n`;
    const { calls, fn } = recordingSpawn({ stdout: jsonl });
    const restore = __setCodexSpawn(fn);
    try {
      const cli = new CodexCli({
        model: "gpt-5.5",
        env: { PATH: process.env.PATH },
        binaryPath: FAKE_CODEX,
      });
      const out = await cli.generate({ system: "SYS", prompt: "do a thing" });
      expect(out).toBe("codex says hi");
      const { argv, opts } = calls[0];
      expect(argv).toContain("exec");
      expect(argv[argv.indexOf("-m") + 1]).toBe("gpt-5.5");
      expect(argv[argv.indexOf("-s") + 1]).toBe("read-only");
      expect(argv).toContain("--skip-git-repo-check");
      expect(argv).toContain("-C");
      expect(argv[argv.indexOf("--color") + 1]).toBe("never");
      expect(argv).toContain("--json");
      // system is folded into the single positional prompt
      const prompt = argv[argv.length - 1];
      expect(prompt).toContain("SYS");
      expect(prompt).toContain("do a thing");
      expect(opts.stdinPath).toBe("/dev/null");
    } finally {
      restore();
    }
  });

  it("THROWS on non-zero exit", async () => {
    const { fn } = recordingSpawn({ code: 2, stdout: "", stderr: "nope" });
    const restore = __setCodexSpawn(fn);
    try {
      const cli = new CodexCli({ env: { PATH: process.env.PATH }, binaryPath: FAKE_CODEX });
      await expect(cli.generate({ prompt: "x" })).rejects.toThrow(/codex exited 2/);
    } finally {
      restore();
    }
  });
});

describe("parseCodexJsonl", () => {
  it("concatenates assistant message fragments from JSONL in order", () => {
    const jsonl = [
      `{"type":"thread.started"}`,
      `{"type":"item.completed","item":{"type":"agent_message","text":"first"}}`,
      `{"type":"item.completed","item":{"type":"agent_message","text":"final answer"}}`,
    ].join("\n");
    expect(parseCodexJsonl(jsonl)).toBe("first\nfinal answer");
  });

  it("ignores non-JSON banner lines", () => {
    const jsonl = `codex 0.139.0 starting...\n{"type":"agent_message","message":"hi"}\n`;
    expect(parseCodexJsonl(jsonl)).toBe("hi");
  });

  it("concatenates ALL assistant fragments in order (does not truncate to the last)", () => {
    const jsonl = [
      `{"type":"item.completed","item":{"type":"agent_message","text":"<response>part one"}}`,
      `{"type":"item.completed","item":{"type":"agent_message","text":"part two</response>"}}`,
    ].join("\n");
    expect(parseCodexJsonl(jsonl)).toBe("<response>part one\npart two</response>");
  });

  it("falls back to raw trimmed stdout ONLY when no line parsed as JSON", () => {
    expect(parseCodexJsonl("  plain text answer  ")).toBe("plain text answer");
  });

  it("THROWS (does not dump raw JSONL) when JSON parsed but no assistant event", () => {
    const jsonl = [`{"type":"thread.started"}`, `{"type":"token_count","count":42}`].join("\n");
    expect(() => parseCodexJsonl(jsonl)).toThrow(/no assistant message/);
  });
});

describe("codex default spawner (fix 1: must default, not throw)", () => {
  it("CodexCli uses the real defaultSpawn when no test seam is installed", async () => {
    // No __setSpawnForTests call here: a production CodexCli must spawn via the
    // module-default spawner, not throw "codex spawner not configured". We point
    // it at `true` (exits 0, no stdout) so the spawn runs but yields empty
    // stdout -> the "empty stdout" guard, NOT the "spawner not configured" error.
    const cli = new CodexCli({ env: { PATH: process.env.PATH }, binaryPath: "/usr/bin/true" });
    await expect(cli.generate({ prompt: "x" })).rejects.toThrow(/empty stdout/);
  });
});

describe("resolveSafeBinary accepts real symlinked installs (fix 2)", () => {
  const hasClaude = binaryOnPath("claude");
  const hasCodex = binaryOnPath("codex");

  it.skipIf(!hasClaude)("resolves a real `claude` install symlinked out of the allowlist", () => {
    const resolved = resolveSafeBinary("claude");
    expect(resolved.length).toBeGreaterThan(0);
  });

  it.skipIf(!hasCodex)("resolves a real `codex` install symlinked out of the allowlist", () => {
    const resolved = resolveSafeBinary("codex");
    expect(resolved.length).toBeGreaterThan(0);
  });

  it("still rejects an absolute path outside every allowlisted dir", () => {
    // /etc exists but is not on the launcher allowlist, so an absolute path
    // there must be refused even though the file exists.
    expect(() => resolveSafeBinary("/etc/hostname")).toThrow(/Could not resolve/);
  });
});

describe("defaultSpawn timeout escalation (fix 6: SIGKILL if SIGTERM ignored)", () => {
  it("escalates to SIGKILL and rejects when the child ignores SIGTERM", async () => {
    // A node child that traps SIGTERM and keeps running. Only SIGKILL (which
    // cannot be trapped) can stop it. With the group-kill + 2s SIGKILL
    // escalation, defaultSpawn must resolve as timedOut well before this 30s
    // sleep would finish.
    const script =
      "process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),30000);process.stderr.write('ready');";
    const result = await defaultSpawn([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" } as Record<string, string>,
      timeoutMs: 300,
      stdinPath: "/dev/null",
    });
    expect(result.timedOut).toBe(true);
    // The child was force-killed: it never ran to its own exit(0), so it closed
    // on a signal rather than code 0.
    expect(result.code).not.toBe(0);
  }, 10_000);
});

describe("plugin routing priority (fix 4)", () => {
  it("registers an explicit high priority so it wins the tiers it serves", () => {
    expect(cliInferencePlugin.priority).toBe(100);
  });
});

describe("models map gating (large-tier only)", () => {
  it("ELIZA_CHAT_VIA_CLI unset -> empty models map", () => {
    expect(resolveCliBackend({})).toBeUndefined();
    expect(buildModels({})).toEqual({});
  });

  it("ELIZA_CHAT_VIA_CLI=claude -> exactly the 3 large-tier handlers, NOT ACTION_PLANNER/TEXT_SMALL/NANO/MEDIUM", () => {
    const models = buildModels({ ELIZA_CHAT_VIA_CLI: "claude" }) as Record<string, unknown>;
    const keys = Object.keys(models).sort();
    expect(keys).toEqual([...LARGE_TIER_MODEL_TYPES].sort());
    expect(keys).toContain("TEXT_LARGE");
    expect(keys).toContain("TEXT_MEGA");
    expect(keys).toContain("RESPONSE_HANDLER");
    // ACTION_PLANNER stays on the grammar/tool-honoring provider — the CLI
    // cannot honor GBNF/native-tool/responseSchema enforcement.
    expect(keys).not.toContain("ACTION_PLANNER");
    expect(keys).not.toContain("TEXT_SMALL");
    expect(keys).not.toContain("TEXT_NANO");
    expect(keys).not.toContain("TEXT_MEDIUM");
  });

  it("ELIZA_CHAT_VIA_CLI=codex -> same large-tier-only set", () => {
    const keys = Object.keys(
      buildModels({ ELIZA_CHAT_VIA_CLI: "codex" }) as Record<string, unknown>
    );
    expect(keys.sort()).toEqual([...LARGE_TIER_MODEL_TYPES].sort());
  });

  it("ELIZA_CHAT_VIA_CLI=claude-sdk -> same large-tier-only set", () => {
    const keys = Object.keys(
      buildModels({ ELIZA_CHAT_VIA_CLI: "claude-sdk" }) as Record<string, unknown>
    );
    expect(keys.sort()).toEqual([...LARGE_TIER_MODEL_TYPES].sort());
  });

  it("routes cold Claude model handlers through the configured backend", async () => {
    const { calls, fn } = recordingSpawn({ stdout: "from claude" });
    const restore = __setClaudeSpawn(fn);
    try {
      const models = buildModels({ ELIZA_CHAT_VIA_CLI: "claude" }) as Record<
        string,
        (
          runtime: { getSetting: (key: string) => string | undefined },
          params: unknown
        ) => Promise<string>
      >;
      // A configured pin keeps model routing independent of the host's CLI layout.
      const runtime = {
        getSetting: (key: string) =>
          key === "ELIZA_CHAT_VIA_CLI"
            ? "claude"
            : key === "ELIZA_CLI_CLAUDE_BIN"
              ? FAKE_CLAUDE
              : undefined,
      };

      await expect(models.TEXT_LARGE(runtime, { prompt: "hello" })).resolves.toBe("from claude");

      const argv = calls[0].argv;
      expect(argv[0]).toBe(FAKE_CLAUDE);
      expect(argv[argv.indexOf("--model") + 1]).toBe("claude-opus-4-8");
    } finally {
      restore();
    }
  });

  it("routes warm Claude SDK handlers through the current default Opus model", async () => {
    let captured: { model?: string; body?: string } = {};
    vi.spyOn(ClaudeSdkSession.prototype, "generate").mockImplementation(function (
      this: ClaudeSdkSession,
      body: string
    ) {
      captured = {
        model: (this as unknown as { model?: string }).model,
        body,
      };
      return Promise.resolve("from sdk");
    });
    const models = buildModels({ ELIZA_CHAT_VIA_CLI: "claude-sdk" }) as Record<
      string,
      (
        runtime: { getSetting: (key: string) => string | undefined },
        params: unknown
      ) => Promise<string>
    >;
    const runtime = {
      getSetting: (key: string) =>
        key === "ELIZA_CHAT_VIA_CLI"
          ? "claude-sdk"
          : key === "ELIZA_CLI_CLAUDE_MODEL"
            ? ""
            : undefined,
    };

    await expect(models.TEXT_LARGE(runtime, { prompt: "hello" })).resolves.toBe("from sdk");

    expect(captured.model).toBe("claude-opus-4-8");
    expect(captured.body).toContain("hello");
  });

  it("registers and routes ACTION_PLANNER only in text-planner mode", async () => {
    process.env.ELIZA_PLANNER_NATIVE_TOOLS = "0";
    const { calls, fn } = recordingSpawn({ stdout: '{"action":"NONE","params":{}}' });
    const restore = __setClaudeSpawn(fn);
    try {
      const models = buildModels({ ELIZA_CHAT_VIA_CLI: "claude" }) as Record<
        string,
        (
          runtime: { getSetting: (key: string) => string | undefined },
          params: unknown
        ) => Promise<string>
      >;
      // The planner and response handlers share the same operator-pinned executable.
      const runtime = {
        getSetting: (key: string) =>
          key === "ELIZA_CHAT_VIA_CLI"
            ? "claude"
            : key === "ELIZA_CLI_CLAUDE_BIN"
              ? FAKE_CLAUDE
              : undefined,
      };

      expect(models.ACTION_PLANNER).toBeTypeOf("function");
      await expect(models.ACTION_PLANNER(runtime, { prompt: "pick an action" })).resolves.toContain(
        "NONE"
      );
      expect(calls).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("routes cold Codex model handlers through the configured binary", async () => {
    const { calls, fn } = recordingSpawn({
      stdout: '{"type":"agent_message","message":"from codex"}',
    });
    const restore = __setCodexSpawn(fn);
    try {
      const models = buildModels({ ELIZA_CHAT_VIA_CLI: "codex" }) as Record<
        string,
        (
          runtime: { getSetting: (key: string) => string | undefined },
          params: unknown
        ) => Promise<string>
      >;
      const runtime = {
        getSetting: (key: string) =>
          key === "ELIZA_CHAT_VIA_CLI"
            ? "codex"
            : key === "ELIZA_CLI_CODEX_BIN"
              ? FAKE_CODEX
              : undefined,
      };

      await expect(models.TEXT_LARGE(runtime, { prompt: "hello" })).resolves.toBe("from codex");

      expect(calls).toHaveLength(1);
      expect(calls[0].argv[0]).toBe(FAKE_CODEX);
    } finally {
      restore();
    }
  });

  it("routes warm Codex SDK handlers through the default Codex model", async () => {
    let captured: { model?: string; body?: string } = {};
    vi.spyOn(CodexSdkSession.prototype, "generate").mockImplementation(function (
      this: CodexSdkSession,
      body: string
    ) {
      captured = {
        model: (this as unknown as { model?: string }).model,
        body,
      };
      return Promise.resolve("from codex sdk");
    });
    const models = buildModels({ ELIZA_CHAT_VIA_CLI: "codex-sdk" }) as Record<
      string,
      (
        runtime: { getSetting: (key: string) => string | undefined },
        params: unknown
      ) => Promise<string>
    >;
    const runtime = {
      getSetting: (key: string) => (key === "ELIZA_CHAT_VIA_CLI" ? "codex-sdk" : undefined),
    };

    await expect(models.TEXT_LARGE(runtime, { prompt: "hello" })).resolves.toBe("from codex sdk");

    expect(captured.model).toBe("gpt-5.5");
    expect(captured.body).toContain("hello");
  });

  it("keeps init inert when disabled and rejects colliding Claude routes", async () => {
    delete process.env.ELIZA_CHAT_VIA_CLI;
    await expect(cliInferencePlugin.init?.({} as never)).resolves.toBeUndefined();

    process.env.ELIZA_CHAT_VIA_CLI = "claude-sdk";
    process.env.ELIZA_ENABLE_CLAUDE_STEALTH = "1";
    await expect(cliInferencePlugin.init?.({} as never)).rejects.toThrow(/collides/);
  });

  it("resolveCliBackend accepts claude|codex|claude-sdk (case-insensitive)", () => {
    expect(resolveCliBackend({ ELIZA_CHAT_VIA_CLI: "Claude" })).toBe("claude");
    expect(resolveCliBackend({ ELIZA_CHAT_VIA_CLI: "CODEX" })).toBe("codex");
    expect(resolveCliBackend({ ELIZA_CHAT_VIA_CLI: "Claude-SDK" })).toBe("claude-sdk");
    expect(resolveCliBackend({ ELIZA_CHAT_VIA_CLI: "gemini" })).toBeUndefined();
    expect(resolveCliBackend({ ELIZA_CHAT_VIA_CLI: "" })).toBeUndefined();
  });

  it("auto-enables for claude-sdk with the same trim/case normalization", () => {
    expect(shouldEnable(autoEnableCtx({ ELIZA_CHAT_VIA_CLI: "  Claude-SDK " }))).toBe(true);
    expect(shouldEnable(autoEnableCtx({ ELIZA_CHAT_VIA_CLI: "gemini" }))).toBe(false);
  });
});

describe("reasoning effort (SDK effort option)", () => {
  it("normalizeEffort accepts the SDK's levels and drops everything else", () => {
    for (const lvl of ["low", "medium", "high", "xhigh", "max"]) {
      expect(normalizeEffort(lvl)).toBe(lvl);
      expect(normalizeEffort(`  ${lvl.toUpperCase()} `)).toBe(lvl);
    }
    for (const junk of ["ultra", "insane", "", "  ", undefined, null, "9"]) {
      expect(normalizeEffort(junk as string)).toBeNull();
    }
  });

  it("forwards a valid effort into the SDK query options", async () => {
    let captured: Record<string, unknown> | undefined;
    const fakeSdk = {
      query: ({ options }: { options: Record<string, unknown> }) => {
        captured = options;
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "assistant",
              message: { content: [{ type: "text", text: "ok" }] },
            };
            yield { type: "result", subtype: "success", result: "ok" };
          },
        };
      },
      tool: () => ({}),
      createSdkMcpServer: () => ({}),
    };
    const session = new ClaudeSdkSession({
      model: "claude-opus-4-8",
      effort: "xhigh",
      sdkModule: fakeSdk as never,
    });
    await session.generate("hi");
    expect(captured?.effort).toBe("xhigh");
    await session.dispose();
  });

  it("omits effort entirely when unset (SDK keeps its default)", async () => {
    let captured: Record<string, unknown> | undefined;
    const fakeSdk = {
      query: ({ options }: { options: Record<string, unknown> }) => {
        captured = options;
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "result", subtype: "success", result: "ok" };
          },
        };
      },
      tool: () => ({}),
      createSdkMcpServer: () => ({}),
    };
    const session = new ClaudeSdkSession({
      model: "claude-opus-4-8",
      sdkModule: fakeSdk as never,
    });
    await session.generate("hi");
    expect(captured && "effort" in captured).toBe(false);
    await session.dispose();
  });

  it("drops a bogus effort rather than forwarding it (would fail the turn)", async () => {
    let captured: Record<string, unknown> | undefined;
    const fakeSdk = {
      query: ({ options }: { options: Record<string, unknown> }) => {
        captured = options;
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "result", subtype: "success", result: "ok" };
          },
        };
      },
      tool: () => ({}),
      createSdkMcpServer: () => ({}),
    };
    const session = new ClaudeSdkSession({
      model: "claude-opus-4-8",
      effort: "ultra",
      sdkModule: fakeSdk as never,
    });
    await session.generate("hi");
    expect(captured && "effort" in captured).toBe(false);
    await session.dispose();
  });
});

describe("resolveSdkEffort (per-tier effort env precedence)", () => {
  // getSetting() falls back to process.env when the runtime returns undefined,
  // so a stray ambient value would defeat the "unset" cases. Clear both keys and
  // drive resolution purely off the fake runtime's settings map.
  const prev = {
    effort: process.env.ELIZA_CLI_CLAUDE_EFFORT,
    planner: process.env.ELIZA_CLI_CLAUDE_PLANNER_EFFORT,
  };
  beforeEach(() => {
    delete process.env.ELIZA_CLI_CLAUDE_EFFORT;
    delete process.env.ELIZA_CLI_CLAUDE_PLANNER_EFFORT;
  });
  afterEach(() => {
    if (prev.effort === undefined) delete process.env.ELIZA_CLI_CLAUDE_EFFORT;
    else process.env.ELIZA_CLI_CLAUDE_EFFORT = prev.effort;
    if (prev.planner === undefined) delete process.env.ELIZA_CLI_CLAUDE_PLANNER_EFFORT;
    else process.env.ELIZA_CLI_CLAUDE_PLANNER_EFFORT = prev.planner;
  });

  const runtimeWith = (settings: Record<string, string>): IAgentRuntime =>
    ({ getSetting: (key: string) => settings[key] }) as unknown as IAgentRuntime;

  it("reply tier (router=false) reads ELIZA_CLI_CLAUDE_EFFORT", () => {
    const runtime = runtimeWith({ ELIZA_CLI_CLAUDE_EFFORT: "high" });
    expect(resolveSdkEffort(runtime, false)).toBe("high");
  });

  it("reply tier ignores the planner override even when it is set", () => {
    const runtime = runtimeWith({
      ELIZA_CLI_CLAUDE_EFFORT: "medium",
      ELIZA_CLI_CLAUDE_PLANNER_EFFORT: "max",
    });
    expect(resolveSdkEffort(runtime, false)).toBe("medium");
  });

  it("planner tier (router=true) prefers ELIZA_CLI_CLAUDE_PLANNER_EFFORT", () => {
    const runtime = runtimeWith({
      ELIZA_CLI_CLAUDE_EFFORT: "low",
      ELIZA_CLI_CLAUDE_PLANNER_EFFORT: "max",
    });
    expect(resolveSdkEffort(runtime, true)).toBe("max");
  });

  it("planner tier falls back to the shared ELIZA_CLI_CLAUDE_EFFORT when its own key is unset", () => {
    const runtime = runtimeWith({ ELIZA_CLI_CLAUDE_EFFORT: "high" });
    expect(resolveSdkEffort(runtime, true)).toBe("high");
  });

  it("returns undefined for both tiers when no effort is configured (SDK keeps its default)", () => {
    const runtime = runtimeWith({});
    expect(resolveSdkEffort(runtime, false)).toBeUndefined();
    expect(resolveSdkEffort(runtime, true)).toBeUndefined();
  });

  it("passes an unrecognized level through unvalidated — validation is normalizeEffort's job at the session", () => {
    // resolveSdkEffort only resolves precedence; the session's normalizeEffort
    // (tested above) drops unknown levels. Keeping the two concerns split means a
    // bad env never silently downgrades a valid per-tier override.
    const runtime = runtimeWith({ ELIZA_CLI_CLAUDE_EFFORT: "ultra" });
    expect(resolveSdkEffort(runtime, false)).toBe("ultra");
    expect(normalizeEffort(resolveSdkEffort(runtime, false))).toBeNull();
  });
});

describe("buildModelMetadata (RUNTIME_MODEL_CONTEXT self-report)", () => {
  const prev = {
    planner: process.env.ELIZA_PLANNER_NATIVE_TOOLS,
    claudeLarge: process.env.ELIZA_CLI_CLAUDE_MODEL,
    claudePlanner: process.env.ELIZA_CLI_CLAUDE_PLANNER_MODEL,
    codexLarge: process.env.ELIZA_CLI_CODEX_MODEL,
  };
  afterEach(() => {
    process.env.ELIZA_PLANNER_NATIVE_TOOLS = prev.planner ?? "";
    process.env.ELIZA_CLI_CLAUDE_MODEL = prev.claudeLarge ?? "";
    process.env.ELIZA_CLI_CLAUDE_PLANNER_MODEL = prev.claudePlanner ?? "";
    process.env.ELIZA_CLI_CODEX_MODEL = prev.codexLarge ?? "";
  });

  it("is undefined when the plugin is inert", () => {
    expect(buildModelMetadata({ ELIZA_CHAT_VIA_CLI: undefined })).toBeUndefined();
    expect(buildModelMetadata({ ELIZA_CHAT_VIA_CLI: "gemini" })).toBeUndefined();
  });

  it("reports the configured claude models per tier (nubs's live config shape)", () => {
    process.env.ELIZA_PLANNER_NATIVE_TOOLS = "0";
    process.env.ELIZA_CLI_CLAUDE_MODEL = "claude-sonnet-5";
    process.env.ELIZA_CLI_CLAUDE_PLANNER_MODEL = "claude-opus-4-8";
    const md = buildModelMetadata({ ELIZA_CHAT_VIA_CLI: "claude-sdk" });
    for (const t of LARGE_TIER_MODEL_TYPES) {
      expect(md?.[t]).toEqual({ displayModel: "claude-sonnet-5" });
    }
    expect(md?.ACTION_PLANNER).toEqual({ displayModel: "claude-opus-4-8" });
  });

  it("planner falls back to the large model when its own key is unset", () => {
    process.env.ELIZA_PLANNER_NATIVE_TOOLS = "0";
    process.env.ELIZA_CLI_CLAUDE_MODEL = "claude-opus-4-8";
    process.env.ELIZA_CLI_CLAUDE_PLANNER_MODEL = "";
    const md = buildModelMetadata({ ELIZA_CHAT_VIA_CLI: "claude-sdk" });
    expect(md?.ACTION_PLANNER).toEqual({ displayModel: "claude-opus-4-8" });
  });

  it("omits ACTION_PLANNER when native-tools planner mode is on (not served here)", () => {
    process.env.ELIZA_PLANNER_NATIVE_TOOLS = "1";
    process.env.ELIZA_CLI_CLAUDE_MODEL = "claude-opus-4-8";
    const md = buildModelMetadata({ ELIZA_CHAT_VIA_CLI: "claude-sdk" });
    expect(md?.ACTION_PLANNER).toBeUndefined();
    expect(md?.RESPONSE_HANDLER).toEqual({ displayModel: "claude-opus-4-8" });
  });

  it("reports codex models for the codex backend", () => {
    process.env.ELIZA_PLANNER_NATIVE_TOOLS = "0";
    process.env.ELIZA_CLI_CODEX_MODEL = "gpt-5.6-sol";
    const md = buildModelMetadata({ ELIZA_CHAT_VIA_CLI: "codex-sdk" });
    expect(md?.RESPONSE_HANDLER).toEqual({ displayModel: "gpt-5.6-sol" });
  });
});
