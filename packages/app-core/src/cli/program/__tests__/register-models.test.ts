import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getLogPrefix: vi.fn(() => "[eliza]"),
}));

vi.mock("@elizaos/shared", () => ({
  getLogPrefix: (...a: unknown[]) => mocks.getLogPrefix(...a),
}));

import { registerModelsCli } from "./register.models.ts";

function fakeProgram() {
  const cmd: {
    description: ReturnType<typeof vi.fn>;
    action: ReturnType<typeof vi.fn>;
  } = {
    description: vi.fn(() => cmd),
    action: vi.fn(() => cmd),
  };
  const program = { command: vi.fn(() => cmd) };
  return { program, cmd };
}

const KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_CLOUD_API_KEY",
  "GROQ_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "TOGETHER_API_KEY",
  "MISTRAL_API_KEY",
  "COHERE_API_KEY",
  "PERPLEXITY_API_KEY",
  "ZAI_API_KEY",
  "MOONSHOT_API_KEY",
  "OLLAMA_BASE_URL",
  "ELIZAOS_CLOUD_API_KEY",
];

describe("registerModelsCli", () => {
  afterEach(() => {
    for (const k of KEYS) delete process.env[k];
  });

  it("registers a models command", () => {
    const { program, cmd } = fakeProgram();
    registerModelsCli(program as never);
    expect(program.command).toHaveBeenCalledWith("models");
    expect(cmd.description).toHaveBeenCalledWith(
      "Show configured model providers",
    );
  });

  it("reports configured and unset providers from env", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const { program, cmd } = fakeProgram();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    registerModelsCli(program as never);
    const action = cmd.action.mock.calls[0][0] as () => void;
    action();
    const all = log.mock.calls.map((c) => c[0] as string).join("\n");
    expect(all).toContain("[eliza] Model providers:");
    expect(all).toContain("OpenAI (GPT): configured");
    expect(all).toContain("Anthropic (Claude): not set");
    expect(all).toContain("DeepSeek: not set");
    log.mockRestore();
  });
});
