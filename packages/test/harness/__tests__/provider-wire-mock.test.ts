/**
 * Keyless wire-level provider e2e.
 *
 * Drives a real `runtime.useModel()` turn through `@elizaos/plugin-openai` and
 * `@elizaos/plugin-anthropic` against the in-process `openai.json` / `anthropic.json`
 * Mockoon environments — no API key, no network egress. This exercises each
 * provider plugin's request/response shaping end-to-end (base-URL routing, auth
 * header, body, response parse) which the `*.shape.test.ts` suites mock away.
 *
 * It depends on the `ELIZA_MOCK_OPENAI_BASE` / `ELIZA_MOCK_ANTHROPIC_BASE` wiring
 * in each plugin's `utils/config.ts` `getBaseURL` (set only by the mock runner).
 * No `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` is set, so the mock-base var is the
 * thing under test. The nightly `external-api-live-drift.yml` lane re-validates
 * the same mock shapes against the live APIs.
 */
import { ModelType } from "@elizaos/core";
import { createRealTestRuntime } from "@elizaos/core/testing";
import { anthropicPlugin } from "@elizaos/plugin-anthropic";
import { openaiPlugin } from "@elizaos/plugin-openai";
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
  // The mock runner exports ELIZA_MOCK_OPENAI_BASE / ELIZA_MOCK_ANTHROPIC_BASE
  // (with the `/v1` prefix); those are the wiring under test. Clear any explicit
  // base-URL override (e.g. a developer's shell `ANTHROPIC_BASE_URL`) so the
  // mock-base var is what getBaseURL resolves to.
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
  it("routes plugin-openai TEXT_SMALL through ELIZA_MOCK_OPENAI_BASE", async () => {
    expect(process.env.ELIZA_MOCK_OPENAI_BASE).toContain("/v1");
    const { runtime, cleanup } = await createRealTestRuntime({
      characterName: "OpenAiWireMock",
      plugins: [openaiPlugin],
    });
    cleanups.push(cleanup);

    const out = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: "ping the mock",
    });

    expect(String(out)).toContain("Mock response from OpenAI fixture");
  });

  it("routes plugin-anthropic TEXT_SMALL through ELIZA_MOCK_ANTHROPIC_BASE", async () => {
    expect(process.env.ELIZA_MOCK_ANTHROPIC_BASE).toContain("/v1");
    const { runtime, cleanup } = await createRealTestRuntime({
      characterName: "AnthropicWireMock",
      plugins: [anthropicPlugin],
    });
    cleanups.push(cleanup);

    const out = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: "ping the mock",
    });

    expect(String(out)).toContain("Mock response from Anthropic fixture");
  });
});
