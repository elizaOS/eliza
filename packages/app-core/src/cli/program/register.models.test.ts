/**
 * Direct unit coverage for `registerModelsCli`. Drives the real registrar
 * against a live Commander program and asserts command wiring plus the
 * observed env-probe listing: every provider in source order, truthy vs
 * falsy keys, empty string, value non-leakage, and that the action never
 * writes env.
 */
import { getLogPrefix } from "@elizaos/shared";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerModelsCli } from "./register.models";

/** Fixed probe table copied from the registrar; order is part of the contract. */
const PROVIDERS = [
  ["ANTHROPIC_API_KEY", "Anthropic (Claude)"],
  ["OPENAI_API_KEY", "OpenAI (GPT)"],
  ["GOOGLE_API_KEY", "Google (Gemini)"],
  ["GOOGLE_CLOUD_API_KEY", "Google Antigravity (Vertex AI)"],
  ["GROQ_API_KEY", "Groq"],
  ["XAI_API_KEY", "xAI (Grok)"],
  ["OPENROUTER_API_KEY", "OpenRouter"],
  ["DEEPSEEK_API_KEY", "DeepSeek"],
  ["TOGETHER_API_KEY", "Together AI"],
  ["MISTRAL_API_KEY", "Mistral"],
  ["COHERE_API_KEY", "Cohere"],
  ["PERPLEXITY_API_KEY", "Perplexity"],
  ["ZAI_API_KEY", "Zai"],
  ["MOONSHOT_API_KEY", "Kimi / Moonshot"],
  ["OLLAMA_BASE_URL", "Ollama (local)"],
  ["ELIZAOS_CLOUD_API_KEY", "elizaOS Cloud"],
] as const;

type ProviderKey = (typeof PROVIDERS)[number][0];

const savedEnv: Partial<Record<ProviderKey, string | undefined>> = {};

function expectedListing(configured: ReadonlySet<string>): string[] {
  return [
    `${getLogPrefix()} Model providers:`,
    ...PROVIDERS.map(
      ([key, name]) =>
        `  ${name}: ${configured.has(key) ? "configured" : "not set"}`,
    ),
  ];
}

async function runModelsCommand(): Promise<string[]> {
  const lines: string[] = [];
  const spy = vi
    .spyOn(console, "log")
    .mockImplementation((message?: unknown) => {
      lines.push(String(message));
    });
  try {
    const program = new Command();
    program.exitOverride();
    registerModelsCli(program);
    await program.parseAsync(["models"], { from: "user" });
    return lines;
  } finally {
    spy.mockRestore();
  }
}

describe("registerModelsCli", () => {
  beforeEach(() => {
    for (const [key] of PROVIDERS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key] of PROVIDERS) {
      const previous = savedEnv[key];
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  it("registers a models command that lists providers, with no extra options", () => {
    const program = new Command();
    registerModelsCli(program);

    expect(program.commands.map((command) => command.name())).toEqual([
      "models",
    ]);
    const models = program.commands[0];
    expect(models?.description()).toBe("Show configured model providers");
    expect(models?.options.map((option) => option.long)).toEqual([]);
  });

  it("does not print anything merely by registering the command", () => {
    const spy = vi.spyOn(console, "log");
    try {
      registerModelsCli(new Command());
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("prints every provider as not set when none of the probed keys are present", async () => {
    const lines = await runModelsCommand();
    expect(lines).toEqual(expectedListing(new Set()));
  });

  it("prints every provider as configured, in source order, when every key is set", async () => {
    for (const [key] of PROVIDERS) {
      process.env[key] = `secret-for-${key}`;
    }
    const lines = await runModelsCommand();
    expect(lines).toEqual(
      expectedListing(new Set(PROVIDERS.map(([key]) => key))),
    );
  });

  it("classifies a mixed queue per-key without reordering", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    process.env.GROQ_API_KEY = "gsk";
    process.env.ELIZAOS_CLOUD_API_KEY = "eliza_cloud";
    const lines = await runModelsCommand();
    expect(lines).toEqual(
      expectedListing(
        new Set(["ANTHROPIC_API_KEY", "GROQ_API_KEY", "ELIZAOS_CLOUD_API_KEY"]),
      ),
    );
  });

  it("treats an empty-string key as not set", async () => {
    process.env.OPENAI_API_KEY = "";
    const lines = await runModelsCommand();
    expect(lines).toEqual(expectedListing(new Set()));
    expect(lines).toContain("  OpenAI (GPT): not set");
  });

  it("treats a whitespace-only key as configured because the probe does not trim", async () => {
    process.env.OPENAI_API_KEY = " ";
    const lines = await runModelsCommand();
    expect(lines).toEqual(expectedListing(new Set(["OPENAI_API_KEY"])));
  });

  it("treats the string 0 as configured (truthy, no numeric coerce)", async () => {
    process.env.XAI_API_KEY = "0";
    const lines = await runModelsCommand();
    expect(lines).toContain("  xAI (Grok): configured");
  });

  it("never writes the env values or key names into the listing", async () => {
    const secret = "sk-this-must-not-leak-into-stdout";
    process.env.OPENAI_API_KEY = secret;
    const output = (await runModelsCommand()).join("\n");
    expect(output).not.toContain(secret);
    expect(output).not.toContain("OPENAI_API_KEY");
    expect(output).toContain("  OpenAI (GPT): configured");
  });

  it("does not write or delete provider env keys", async () => {
    process.env.XAI_API_KEY = "keep-me";
    const snapshot = Object.fromEntries(
      PROVIDERS.map(([key]) => [key, process.env[key]]),
    );
    await runModelsCommand();
    expect(process.env.XAI_API_KEY).toBe("keep-me");
    for (const [key] of PROVIDERS) {
      expect(process.env[key]).toBe(snapshot[key]);
    }
  });

  it("does not list env vars outside the fixed provider table", async () => {
    const extraKey = "SOME_RANDOM_API_KEY";
    const previous = process.env[extraKey];
    process.env[extraKey] = "yes";
    try {
      const output = (await runModelsCommand()).join("\n");
      expect(output).not.toContain("SOME_RANDOM");
      expect(output.split("\n")).toHaveLength(PROVIDERS.length + 1);
    } finally {
      if (previous === undefined) delete process.env[extraKey];
      else process.env[extraKey] = previous;
    }
  });
});
