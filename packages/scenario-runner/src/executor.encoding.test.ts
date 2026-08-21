/** Malformed scenario route path percent-encoding must not throw. */
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
  ChannelType: {},
  createMessageMemory: vi.fn(),
  ElizaError: class ElizaError extends Error {},
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  MemoryType: {},
  stringToUuid: (value: string) => value,
}));
vi.mock("@elizaos/plugin-local-inference/voice-workbench", () => ({}));
vi.mock("@elizaos/scenario-runner/schema", () => ({
  DEFAULT_SCENARIO_EXECUTION_PROFILE: {},
  scenarioLane: () => "default",
}));
vi.mock("./action-families.ts", () => ({
  actionMatchesScenarioExpectation: () => false,
}));
vi.mock("./final-checks/index.ts", () => ({ runFinalCheck: vi.fn() }));
vi.mock("./interceptor.ts", () => ({ attachInterceptor: vi.fn() }));
vi.mock("./judge.ts", () => ({ judgeTextWithLlm: vi.fn() }));
vi.mock("./judge-independence.ts", () => ({
  deterministicJudgeFixturesActive: () => false,
  isJudgeIndependent: () => false,
  judgeIndependenceRequired: () => false,
}));
vi.mock("./redaction.ts", () => ({
  redactForScenarioReport: (value: unknown) => value,
}));
vi.mock("./required-plugins.ts", () => ({
  assertProviderQualifiedPluginPackages: vi.fn(),
  loadScenarioRequiredPlugin: vi.fn(),
  pluginPackageIsRegistered: () => false,
  resolveRequiredPluginPackages: () => [],
}));
vi.mock("./required-services.ts", () => ({
  waitForScenarioRequiredServices: vi.fn(),
}));
vi.mock("./seeds.ts", () => ({ applyScenarioSeedStep: vi.fn() }));
vi.mock("./utils.js", () => ({
  isLoopbackUrl: () => false,
  toRecord: () => ({}),
}));
vi.mock("./voice-turn.ts", () => ({
  executeVoiceTurn: vi.fn(),
  voiceTurnAssertionFailures: () => [],
}));

import { matchRoutePath } from "./executor";

describe("matchRoutePath encoding", () => {
  it("returns null for a lone % param", () => {
    expect(() => matchRoutePath("/views/:id", "/views/%")).not.toThrow();
    expect(matchRoutePath("/views/:id", "/views/%")).toBeNull();
  });

  it("returns null for %ZZ", () => {
    expect(matchRoutePath("/views/:id", "/views/%ZZ")).toBeNull();
  });

  it("returns null for truncated UTF-8", () => {
    expect(matchRoutePath("/views/:id", "/views/%E0%A4%A")).toBeNull();
  });

  it("still decodes a valid %20 param", () => {
    expect(matchRoutePath("/views/:id", "/views/chat%20home")).toEqual({
      id: "chat home",
    });
  });
});
