import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  initialize: vi.fn(),
  stop: vi.fn(),
  initStorage: vi.fn(),
}));
vi.mock("@elizaos/core", () => ({
  AgentRuntime: class {
    agentId = "test-agent";
    initialize = fixture.initialize;
    stop = fixture.stop;
    registerDatabaseAdapter() {}
    setSetting() {}
  },
}));
vi.mock("@elizaos/plugin-openai", () => ({ openaiPlugin: { name: "openai" } }));
vi.mock("./sqlite-adapter.ts", () => ({
  SQLiteDatabaseAdapter: { create: () => ({ init: fixture.initStorage }) },
}));

import { buildLiveHarness } from "./live-agent.ts";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("OPENAI_BASE_URL", "https://configured.example/v1");
  vi.stubEnv("CEREBRAS_API_KEY", "test-cerebras-key");
});
afterEach(() => vi.unstubAllEnvs());

it("restores provider overrides when an extra plugin cannot load", async () => {
  await expect(
    buildLiveHarness({
      requiredEnv: [],
      extraPlugins: ["./missing-live-test-provider.ts"],
    }),
  ).rejects.toThrow();
  expect(process.env.OPENAI_API_KEY).toBe("");
  expect(process.env.OPENAI_BASE_URL).toBe("https://configured.example/v1");
  expect(fixture.stop).not.toHaveBeenCalled();
});

it.each(["initialize", "initStorage"] as const)(
  "stops a partial runtime after %s fails",
  async (phase) => {
    const failure = new Error(`${phase} failed`);
    fixture[phase].mockRejectedValueOnce(failure);
    await expect(buildLiveHarness({ requiredEnv: [] })).rejects.toBe(failure);
    expect(fixture.stop).toHaveBeenCalledOnce();
    expect(process.env.OPENAI_API_KEY).toBe("");
  },
);

it("preserves startup and cleanup failures and restores the environment", async () => {
  const startup = new Error("startup failed");
  const cleanup = new Error("cleanup failed");
  fixture.initialize.mockRejectedValueOnce(startup);
  fixture.stop.mockRejectedValueOnce(cleanup);
  await expect(buildLiveHarness({ requiredEnv: [] })).rejects.toMatchObject({
    errors: [startup, cleanup],
  });
  expect(process.env.OPENAI_API_KEY).toBe("");
});

it("keeps overrides until close, including when runtime stop fails", async () => {
  const harness = await buildLiveHarness({ requiredEnv: [] });
  expect(process.env.OPENAI_API_KEY).toBe("test-cerebras-key");
  fixture.stop.mockRejectedValueOnce(new Error("stop failed"));
  await expect(harness.close()).rejects.toThrow("stop failed");
  expect(process.env.OPENAI_API_KEY).toBe("");
});
