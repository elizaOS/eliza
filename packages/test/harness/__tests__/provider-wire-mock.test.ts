/**
 * Keyless wire-level provider e2e.
 *
 * Proves `@elizaos/plugin-openai` / `@elizaos/plugin-anthropic` consume the
 * `openai.json` / `anthropic.json` Mockoon environments via the
 * `ELIZA_MOCK_OPENAI_BASE` / `ELIZA_MOCK_ANTHROPIC_BASE` wiring in each plugin's
 * `utils/config.ts` `getBaseURL` — no API key, no network egress.
 *
 * - The wiring is asserted directly: `getBaseURL(runtime)` resolves to the mock
 *   base when the mock var is set (the AC: "consumed by the provider plugin").
 * - Each plugin additionally round-trips a real `useModel()` turn through its
 *   mock. The openai mock returns a static fixture string; the anthropic mock's
 *   `/v1/messages` is dynamic and replies "pong".
 *
 * The nightly `external-api-live-drift.yml` lane re-validates the same mock
 * shapes against the live APIs.
 */
import { ModelType } from "@elizaos/core";
import { createRealTestRuntime } from "@elizaos/core/testing";
import { anthropicPlugin } from "@elizaos/plugin-anthropic";
import { getBaseURL as anthropicBaseURL } from "@elizaos/plugin-anthropic/utils/config";
import { openaiPlugin } from "@elizaos/plugin-openai";
import { getBaseURL as openaiBaseURL } from "@elizaos/plugin-openai/utils/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMocks } from "../../mocks/scripts/start-mocks.ts";

type Mocks = Awaited<ReturnType<typeof startMocks>>;

const cleanups: Array<() => Promise<void>> = [];
let mocks: Mocks;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  process.env[key] = value;
}

function unsetEnv(key: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  delete process.env[key];
}

beforeAll(async () => {
  mocks = await startMocks({ envs: ["openai", "anthropic"] });
  // Clear any explicit base-URL override (e.g. a developer's shell) so the
  // ELIZA_MOCK_*_BASE wiring is the thing under test.
  unsetEnv("OPENAI_BASE_URL");
  unsetEnv("ANTHROPIC_BASE_URL");
  for (const [key, value] of Object.entries(mocks.envVars)) setEnv(key, value);
  setEnv("OPENAI_API_KEY", "test-openai-key");
  setEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
});

afterAll(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
  await mocks?.stop();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("provider wire-mock e2e (keyless)", () => {
  it("plugin-openai getBaseURL honors ELIZA_MOCK_OPENAI_BASE", async () => {
    const { runtime, cleanup } = await createRealTestRuntime({
      characterName: "OpenAiWire",
      plugins: [openaiPlugin],
    });
    cleanups.push(cleanup);
    expect(openaiBaseURL(runtime)).toBe(process.env.ELIZA_MOCK_OPENAI_BASE);
  });

  it("plugin-openai drives a keyless TEXT_SMALL turn through the openai.json mock", async () => {
    const { runtime, cleanup } = await createRealTestRuntime({
      characterName: "OpenAiWireTurn",
      plugins: [openaiPlugin],
    });
    cleanups.push(cleanup);
    const out = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: "ping the mock",
    });
    expect(String(out)).toContain("Mock response from OpenAI fixture");
  });

  it("plugin-anthropic getBaseURL honors ELIZA_MOCK_ANTHROPIC_BASE", async () => {
    const { runtime, cleanup } = await createRealTestRuntime({
      characterName: "AnthropicWire",
      plugins: [anthropicPlugin],
    });
    cleanups.push(cleanup);
    expect(anthropicBaseURL(runtime)).toBe(
      process.env.ELIZA_MOCK_ANTHROPIC_BASE,
    );
  });

  it("plugin-anthropic drives a keyless TEXT_SMALL turn through the anthropic.json mock", async () => {
    const { runtime, cleanup } = await createRealTestRuntime({
      characterName: "AnthropicWireTurn",
      plugins: [anthropicPlugin],
    });
    cleanups.push(cleanup);
    // getBaseURL is the mock (asserted above), so the SDK client is pointed at
    // the mock; its dynamic /v1/messages handler replies "pong".
    const out = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: "ping",
    });
    expect(String(out).toLowerCase()).toContain("pong");
  });
});
