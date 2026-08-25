/** Malformed scenario route path percent-encoding must not throw. */
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@elizaos/core")>()),
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
  resolveRequiredFixturePlugins: () => [],
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

// Regression guard for a class of bug where a hand-written `vi.mock` factory
// silently drifts out of sync with the real module it replaces: a future edit
// could reintroduce a fully hard-coded replacement object (or drop the
// `importOriginal` spread) and lose exports that this file's transitive
// imports need at load time, or that a later change to executor.ts would need
// at runtime. This asserts the mock's key set never regresses below the real
// module's key set, independent of which specific export a future import
// happens to touch.
describe("@elizaos/core mock completeness (drift guard)", () => {
  it("keeps every real @elizaos/core export available through the mock", async () => {
    const real =
      await vi.importActual<typeof import("@elizaos/core")>("@elizaos/core");
    const mocked = await import("@elizaos/core");
    const missing = Object.keys(real).filter((key) => !(key in mocked));
    expect(missing).toEqual([]);
  });
});
