/**
 * Direct unit coverage for `register.setup`: config read/write, model-key
 * detection order, the injectable provider wizard, and Commander `setup`
 * wiring plus the non-interactive --provider/--key write path. Drives the
 * real module against temp directories; ask/askSecret/log are the wizard's
 * own seams, not a mock of the registrar.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatDocsLink } from "@elizaos/shared";
import { Command, CommanderError } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasModelKey,
  loadConfig,
  registerSetupCommand,
  resolveConfigPath,
  runProviderWizard,
  saveConfig,
} from "./register.setup";

/** Source-order table copied from `hasModelKey`; first non-blank wins. */
const MODEL_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GROQ_API_KEY",
  "XAI_API_KEY",
  "GROK_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "TOGETHER_API_KEY",
  "MISTRAL_API_KEY",
  "COHERE_API_KEY",
  "PERPLEXITY_API_KEY",
  "ZAI_API_KEY",
  "Z_AI_API_KEY",
  "MOONSHOT_API_KEY",
  "KIMI_API_KEY",
  "ELIZAOS_CLOUD_API_KEY",
  "OLLAMA_BASE_URL",
] as const;

const tempDirs: string[] = [];
const spies: Array<{ mockRestore: () => void }> = [];
const ORIGINAL_CONFIG_PATH = process.env.ELIZA_CONFIG_PATH;
const ORIGINAL_STATE_DIR = process.env.ELIZA_STATE_DIR;

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "register-setup-"));
  tempDirs.push(dir);
  return dir;
}

function configPathIn(dir: string): string {
  return path.join(dir, "eliza.json");
}

function scriptedPrompt(answers: string[]): {
  remaining: string[];
  prompt: (query: string) => Promise<string>;
} {
  const remaining = [...answers];
  return {
    remaining,
    prompt: async () => {
      const next = remaining.shift();
      if (next === undefined) {
        throw new Error("unexpected extra prompt");
      }
      return next;
    },
  };
}

function captureConsole(): { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  spies.push(
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    }),
  );
  spies.push(
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    }),
  );
  return { logs, errors };
}

function refuseProcessExit(): { exits: number[] } {
  const exits: number[] = [];
  spies.push(
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exits.push(code ?? 0);
      throw new Error(`process.exit:${code ?? 0}`);
    }) as typeof process.exit),
  );
  return { exits };
}

function parseUserArgs(program: Command, args: string[]): CommanderError {
  try {
    program.parse(args, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      return error;
    }
    throw error;
  }
  throw new Error(`parse(${JSON.stringify(args)}) returned without exiting`);
}

afterEach(() => {
  for (const spy of spies.splice(0)) {
    spy.mockRestore();
  }
  if (ORIGINAL_CONFIG_PATH === undefined) {
    delete process.env.ELIZA_CONFIG_PATH;
  } else {
    process.env.ELIZA_CONFIG_PATH = ORIGINAL_CONFIG_PATH;
  }
  if (ORIGINAL_STATE_DIR === undefined) {
    delete process.env.ELIZA_STATE_DIR;
  } else {
    process.env.ELIZA_STATE_DIR = ORIGINAL_STATE_DIR;
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadConfig", () => {
  it("returns an empty object when the file is missing", () => {
    const missing = path.join(makeTempDir(), "no-such.json");
    expect(existsSync(missing)).toBe(false);
    expect(loadConfig(missing)).toEqual({});
  });

  it("parses JSON5 with comments, unquoted keys, and a trailing comma", () => {
    const file = configPathIn(makeTempDir());
    writeFileSync(
      file,
      `{
        // comment
        env: { OPENAI_API_KEY: "sk-json5", },
      }\n`,
    );
    expect(loadConfig(file)).toEqual({
      env: { OPENAI_API_KEY: "sk-json5" },
    });
  });

  it("returns {} for JSON primitives and null", () => {
    const dir = makeTempDir();
    for (const [name, body] of [
      ["null.json", "null"],
      ["true.json", "true"],
      ["num.json", "42"],
      ["str.json", '"hello"'],
    ] as const) {
      const file = path.join(dir, name);
      writeFileSync(file, body);
      expect(loadConfig(file)).toEqual({});
    }
  });

  it("returns a JSON array as-is because arrays are objects", () => {
    const file = configPathIn(makeTempDir());
    writeFileSync(file, "[1, 2]");
    expect(loadConfig(file)).toEqual([1, 2]);
  });

  it("throws a path-qualified parse error for malformed JSON5", () => {
    const file = configPathIn(makeTempDir());
    writeFileSync(file, "{ not json");
    expect(() => loadConfig(file)).toThrow(
      new RegExp(
        `Cannot parse config at ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      ),
    );
    expect(() => loadConfig(file)).toThrow(
      /Fix or remove the file before running setup/,
    );
  });
});

describe("saveConfig", () => {
  it("creates missing parent directories and writes pretty JSON with a trailing newline", () => {
    const file = path.join(makeTempDir(), "nested", "dir", "eliza.json");
    const config = { env: { XAI_API_KEY: "xai-1" } };
    saveConfig(file, config);
    const raw = readFileSync(file, "utf-8");
    expect(raw).toBe(`${JSON.stringify(config, null, 2)}\n`);
  });

  it("overwrites an existing file rather than merging on disk", () => {
    const file = configPathIn(makeTempDir());
    saveConfig(file, { keep: true, env: { OPENAI_API_KEY: "old" } });
    saveConfig(file, { env: { OPENAI_API_KEY: "new" } });
    expect(loadConfig(file)).toEqual({ env: { OPENAI_API_KEY: "new" } });
  });
});

describe("hasModelKey", () => {
  it("returns null for an empty env, whitespace-only values, and unknown keys", () => {
    expect(hasModelKey({})).toBeNull();
    expect(hasModelKey({ OPENAI_API_KEY: "" })).toBeNull();
    expect(hasModelKey({ OPENAI_API_KEY: "   \t  " })).toBeNull();
    expect(hasModelKey({ SOME_OTHER_API_KEY: "secret" })).toBeNull();
  });

  it("returns the first configured key in source order when several are set", () => {
    const env: Record<string, string> = {};
    for (const key of MODEL_KEYS) {
      env[key] = `value-for-${key}`;
    }
    expect(hasModelKey(env)).toBe("ANTHROPIC_API_KEY");
  });

  it("skips a blank earlier key and returns the next populated one", () => {
    expect(
      hasModelKey({
        ANTHROPIC_API_KEY: "  ",
        CLAUDE_API_KEY: "sk-claude",
        OPENAI_API_KEY: "sk-openai",
      }),
    ).toBe("CLAUDE_API_KEY");
  });

  it("prefers each alias's earlier sibling when both are populated", () => {
    expect(
      hasModelKey({
        XAI_API_KEY: "xai-1",
        GROK_API_KEY: "grok-1",
      }),
    ).toBe("XAI_API_KEY");
    expect(
      hasModelKey({
        GOOGLE_API_KEY: "g-1",
        GOOGLE_GENERATIVE_AI_API_KEY: "g-2",
      }),
    ).toBe("GOOGLE_API_KEY");
    expect(
      hasModelKey({
        ZAI_API_KEY: "z-1",
        Z_AI_API_KEY: "z-2",
      }),
    ).toBe("ZAI_API_KEY");
    expect(
      hasModelKey({
        MOONSHOT_API_KEY: "ms-1",
        KIMI_API_KEY: "kimi-1",
      }),
    ).toBe("MOONSHOT_API_KEY");
  });

  it("accepts a lone last-table entry (Ollama URL)", () => {
    expect(hasModelKey({ OLLAMA_BASE_URL: "http://localhost:11434" })).toBe(
      "OLLAMA_BASE_URL",
    );
  });
});

describe("runProviderWizard", () => {
  it("returns without writing when an existing key is not reconfigured", async () => {
    const file = configPathIn(makeTempDir());
    saveConfig(file, { env: { OPENAI_API_KEY: "sk-keep" } });
    const logs: string[] = [];
    const ask = scriptedPrompt(["n"]);
    const secret = scriptedPrompt([]);

    await runProviderWizard(file, {
      ask: ask.prompt,
      askSecret: secret.prompt,
      env: {},
      log: (message) => logs.push(message),
    });

    expect(ask.remaining).toEqual([]);
    expect(secret.remaining).toEqual([]);
    expect(logs.join("\n")).toContain("OPENAI_API_KEY");
    expect(logs.join("\n")).not.toContain("Model Provider Setup");
    expect(loadConfig(file)).toEqual({ env: { OPENAI_API_KEY: "sk-keep" } });
  });

  it("treats only trimmed lowercase 'y' as consent to reconfigure", async () => {
    const file = configPathIn(makeTempDir());
    const logs: string[] = [];
    await runProviderWizard(file, {
      ask: async () => "yes",
      askSecret: async () => "should-not-run",
      env: { ANTHROPIC_API_KEY: "sk-ant" },
      log: (message) => logs.push(message),
    });
    expect(logs.join("\n")).not.toContain("Model Provider Setup");
    expect(existsSync(file)).toBe(false);
  });

  it("reconfigures on 'Y' and saves the chosen provider key", async () => {
    const file = configPathIn(makeTempDir());
    saveConfig(file, { env: { OPENAI_API_KEY: "sk-old", KEEP: "yes" } });
    const logs: string[] = [];

    await runProviderWizard(file, {
      ask: scriptedPrompt(["Y", "2"]).prompt,
      askSecret: async () => "sk-new",
      env: {},
      log: (message) => logs.push(message),
    });

    expect(loadConfig(file)).toEqual({
      env: { OPENAI_API_KEY: "sk-new", KEEP: "yes" },
    });
    expect(logs.join("\n")).toContain("OPENAI_API_KEY");
  });

  it("defaults an empty choice to the first provider (Anthropic)", async () => {
    const file = configPathIn(makeTempDir());
    await runProviderWizard(file, {
      ask: async () => "",
      askSecret: async () => "sk-ant-default",
      env: {},
      log: () => undefined,
    });
    expect(loadConfig(file)).toEqual({
      env: { ANTHROPIC_API_KEY: "sk-ant-default" },
    });
  });

  it("skips setup for invalid numeric, negative, overflow, and NaN choices", async () => {
    const dir = makeTempDir();
    for (const choice of ["0", "-1", "13", "99", "abc", " "]) {
      const file = path.join(dir, `${choice.replace(/\s/g, "_")}.json`);
      const logs: string[] = [];
      await runProviderWizard(file, {
        ask: async () => choice,
        askSecret: async () => "unused",
        env: {},
        log: (message) => logs.push(message),
      });
      expect(logs.join("\n")).toContain("Invalid choice");
      expect(existsSync(file)).toBe(false);
    }
  });

  it("skips writing when the operator picks 'Skip for now'", async () => {
    const file = configPathIn(makeTempDir());
    const logs: string[] = [];
    await runProviderWizard(file, {
      ask: async () => "12",
      askSecret: async () => "unused",
      env: {},
      log: (message) => logs.push(message),
    });
    expect(logs.join("\n")).toContain("Skipped");
    expect(existsSync(file)).toBe(false);
  });

  it("skips writing when the secret prompt returns empty", async () => {
    const file = configPathIn(makeTempDir());
    const logs: string[] = [];
    await runProviderWizard(file, {
      ask: async () => "5",
      askSecret: async () => "",
      env: {},
      log: (message) => logs.push(message),
    });
    expect(logs.join("\n")).toContain("No value entered");
    expect(existsSync(file)).toBe(false);
  });

  it("defaults an empty Ollama URL to localhost and saves OLLAMA_BASE_URL", async () => {
    const file = configPathIn(makeTempDir());
    await runProviderWizard(file, {
      ask: scriptedPrompt(["11", ""]).prompt,
      askSecret: async () => {
        throw new Error("Ollama must not use the secret prompt");
      },
      env: {},
      log: () => undefined,
    });
    expect(loadConfig(file)).toEqual({
      env: { OLLAMA_BASE_URL: "http://localhost:11434" },
    });
  });

  it("saves a custom Ollama URL entered at the URL prompt", async () => {
    const file = configPathIn(makeTempDir());
    await runProviderWizard(file, {
      ask: scriptedPrompt(["11", "http://127.0.0.1:11434"]).prompt,
      askSecret: async () => {
        throw new Error("Ollama must not use the secret prompt");
      },
      env: {},
      log: () => undefined,
    });
    expect(loadConfig(file)).toEqual({
      env: { OLLAMA_BASE_URL: "http://127.0.0.1:11434" },
    });
  });

  it("saves a no-hint provider (z.ai) from the numbered menu", async () => {
    const file = configPathIn(makeTempDir());
    await runProviderWizard(file, {
      ask: async () => "8",
      askSecret: async () => "zai-secret",
      env: {},
      log: () => undefined,
    });
    expect(loadConfig(file)).toEqual({ env: { ZAI_API_KEY: "zai-secret" } });
  });

  it("ignores a non-object config env section and treats the queue as empty", async () => {
    const file = configPathIn(makeTempDir());
    writeFileSync(file, JSON.stringify({ env: ["OPENAI_API_KEY"] }));
    const logs: string[] = [];
    await runProviderWizard(file, {
      ask: async () => "12",
      env: { OPENAI_API_KEY: undefined },
      log: (message) => logs.push(message),
    });
    expect(logs.join("\n")).toContain("Model Provider Setup");
    expect(logs.join("\n")).not.toContain("already set");
  });

  it("lets config env overlay win over the injected process env on the same key", async () => {
    const file = configPathIn(makeTempDir());
    saveConfig(file, { env: { OPENAI_API_KEY: "from-file" } });
    const logs: string[] = [];
    await runProviderWizard(file, {
      ask: async () => "n",
      env: { OPENAI_API_KEY: "from-env" },
      log: (message) => logs.push(message),
    });
    expect(logs.join("\n")).toContain("OPENAI_API_KEY");
    expect(loadConfig(file)).toEqual({ env: { OPENAI_API_KEY: "from-file" } });
  });

  it("lists every provider label including Skip for now", async () => {
    const file = configPathIn(makeTempDir());
    const logs: string[] = [];
    await runProviderWizard(file, {
      ask: async () => "12",
      env: {},
      log: (message) => logs.push(message),
    });
    const joined = logs.join("\n");
    for (const label of [
      "Anthropic (Claude)",
      "OpenAI (GPT)",
      "Google (Gemini)",
      "Groq",
      "xAI (Grok)",
      "OpenRouter",
      "DeepSeek",
      "z.ai",
      "Kimi / Moonshot",
      "Mistral",
      "Ollama (local, no key)",
      "Skip for now",
    ]) {
      expect(joined).toContain(label);
    }
  });

  it("uses the real non-TTY ask helpers and skips when stdin is not a TTY", async () => {
    const file = configPathIn(makeTempDir());
    const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
    const previous = stdin.isTTY;
    stdin.isTTY = false;
    const logs: string[] = [];
    try {
      await runProviderWizard(file, {
        env: {},
        log: (message) => logs.push(message),
      });
    } finally {
      stdin.isTTY = previous;
    }
    expect(logs.join("\n")).toContain("No value entered");
    expect(existsSync(file)).toBe(false);
  });
});

describe("resolveConfigPath", () => {
  it("honors ELIZA_CONFIG_PATH as an absolute override", () => {
    const file = path.join(makeTempDir(), "override.json");
    process.env.ELIZA_CONFIG_PATH = file;
    expect(resolveConfigPath()).toBe(path.resolve(file));
  });
});

describe("registerSetupCommand", () => {
  it("registers setup with workspace, provider, key, key-stdin, and no-wizard flags", () => {
    const program = new Command();
    registerSetupCommand(program);

    expect(program.commands.map((command) => command.name())).toEqual([
      "setup",
    ]);
    const setup = program.commands[0];
    expect(setup?.description()).toBe(
      "Initialize the XDG state-dir config and agent workspace",
    );
    expect(setup?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining([
        "--workspace",
        "--provider",
        "--key",
        "--key-stdin",
        "--no-wizard",
      ]),
    );
  });

  it("appends the setup docs link after --help", () => {
    const out: string[] = [];
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeOut: (chunk) => {
        out.push(chunk);
      },
      writeErr() {},
    });
    registerSetupCommand(program);

    const error = parseUserArgs(program, ["setup", "--help"]);
    expect(error.code).toBe("commander.helpDisplayed");
    const help = out.join("");
    expect(help).toContain("Usage:");
    expect(help).toContain("--workspace");
    expect(help).toContain("Docs:");
    expect(help).toContain(
      formatDocsLink(
        "/getting-started/setup",
        "docs.eliza.ai/getting-started/setup",
      ),
    );
  });

  it("saves a label-matched provider key non-interactively and warns about --key", async () => {
    const dir = makeTempDir();
    const file = configPathIn(dir);
    const workspace = path.join(dir, "workspace");
    process.env.ELIZA_CONFIG_PATH = file;
    process.env.ELIZA_STATE_DIR = dir;
    const { logs, errors } = captureConsole();
    const { exits } = refuseProcessExit();

    const program = new Command();
    program.exitOverride();
    registerSetupCommand(program);
    await program.parseAsync(
      [
        "setup",
        "--no-wizard",
        "--workspace",
        workspace,
        "--provider",
        "openai",
        "--key",
        "sk-from-flag",
      ],
      { from: "user" },
    );

    expect(exits).toEqual([]);
    expect(errors).toEqual([]);
    expect(loadConfig(file)).toEqual({
      env: { OPENAI_API_KEY: "sk-from-flag" },
    });
    expect(existsSync(workspace)).toBe(true);
    expect(logs.join("\n")).toContain("OPENAI_API_KEY");
    expect(logs.join("\n")).toContain("Prefer --key-stdin");
    expect(logs.join("\n")).toContain("Setup complete.");
  });

  it("matches a provider by env-key substring (xai)", async () => {
    const dir = makeTempDir();
    const file = configPathIn(dir);
    const workspace = path.join(dir, "workspace");
    process.env.ELIZA_CONFIG_PATH = file;
    process.env.ELIZA_STATE_DIR = dir;
    const { logs } = captureConsole();
    refuseProcessExit();

    const program = new Command();
    program.exitOverride();
    registerSetupCommand(program);
    await program.parseAsync(
      [
        "setup",
        "--no-wizard",
        "--workspace",
        workspace,
        "--provider",
        "xai",
        "--key",
        "xai-from-flag",
      ],
      { from: "user" },
    );

    expect(loadConfig(file)).toEqual({
      env: { XAI_API_KEY: "xai-from-flag" },
    });
    expect(logs.join("\n")).toContain("XAI_API_KEY");
  });

  it("synthesizes PROVIDER_API_KEY for an unknown provider name", async () => {
    const dir = makeTempDir();
    const file = configPathIn(dir);
    const workspace = path.join(dir, "workspace");
    process.env.ELIZA_CONFIG_PATH = file;
    process.env.ELIZA_STATE_DIR = dir;
    captureConsole();
    refuseProcessExit();

    const program = new Command();
    program.exitOverride();
    registerSetupCommand(program);
    await program.parseAsync(
      [
        "setup",
        "--no-wizard",
        "--workspace",
        workspace,
        "--provider",
        "acme-labs",
        "--key",
        "acme-secret",
      ],
      { from: "user" },
    );

    expect(loadConfig(file)).toEqual({
      env: { ACME_LABS_API_KEY: "acme-secret" },
    });
  });

  it("synthesizes SKIP_API_KEY when the menu skip entry is selected by label", async () => {
    const dir = makeTempDir();
    const file = configPathIn(dir);
    const workspace = path.join(dir, "workspace");
    process.env.ELIZA_CONFIG_PATH = file;
    process.env.ELIZA_STATE_DIR = dir;
    captureConsole();
    refuseProcessExit();

    const program = new Command();
    program.exitOverride();
    registerSetupCommand(program);
    await program.parseAsync(
      [
        "setup",
        "--no-wizard",
        "--workspace",
        workspace,
        "--provider",
        "skip",
        "--key",
        "should-still-save",
      ],
      { from: "user" },
    );

    expect(loadConfig(file)).toEqual({
      env: { SKIP_API_KEY: "should-still-save" },
    });
  });

  it("bootstraps a workspace without writing a provider when flags omit the key", async () => {
    const dir = makeTempDir();
    const file = configPathIn(dir);
    const workspace = path.join(dir, "workspace");
    process.env.ELIZA_CONFIG_PATH = file;
    process.env.ELIZA_STATE_DIR = dir;
    const { logs } = captureConsole();
    const { exits } = refuseProcessExit();

    const program = new Command();
    program.exitOverride();
    registerSetupCommand(program);
    await program.parseAsync(
      ["setup", "--no-wizard", "--workspace", workspace],
      { from: "user" },
    );

    expect(exits).toEqual([]);
    expect(existsSync(workspace)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(logs.join("\n")).toContain("Setup complete.");
    expect(logs.join("\n")).not.toContain("Prefer --key-stdin");
  });
});
