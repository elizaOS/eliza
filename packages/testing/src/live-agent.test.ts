import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  initialize: vi.fn(),
  stop: vi.fn(),
  close: vi.fn(),
  initStorage: vi.fn(),
}));
vi.mock("@elizaos/core", () => ({
  AgentRuntime: class {
    agentId = "test-agent";
    initialize = fixture.initialize;
    stop = fixture.stop;
    close = fixture.close;
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
  expect(fixture.close).not.toHaveBeenCalled();
});

it.each(["initialize", "initStorage"] as const)(
  "stops a partial runtime after %s fails",
  async (phase) => {
    const failure = new Error(`${phase} failed`);
    fixture[phase].mockRejectedValueOnce(failure);
    await expect(buildLiveHarness({ requiredEnv: [] })).rejects.toBe(failure);
    expect(fixture.stop).toHaveBeenCalledOnce();
    expect(fixture.close).toHaveBeenCalledOnce();
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

it("closes storage after stop fails and preserves both cleanup failures", async () => {
  const harness = await buildLiveHarness({ requiredEnv: [] });
  const stop = new Error("stop failed");
  const close = new Error("close failed");
  fixture.stop.mockRejectedValueOnce(stop);
  fixture.close.mockRejectedValueOnce(close);
  await expect(harness.close()).rejects.toMatchObject({
    errors: [stop, close],
  });
  expect(fixture.close).toHaveBeenCalledOnce();
  expect(process.env.OPENAI_API_KEY).toBe("");
});

it("preserves startup, stop and close failures with environment restoration", async () => {
  const startup = new Error("startup failed");
  const stop = new Error("stop failed");
  const close = new Error("close failed");
  fixture.initialize.mockRejectedValueOnce(startup);
  fixture.stop.mockRejectedValueOnce(stop);
  fixture.close.mockRejectedValueOnce(close);
  await expect(buildLiveHarness({ requiredEnv: [] })).rejects.toMatchObject({
    errors: [startup, { errors: [stop, close] }],
  });
  expect(process.env.OPENAI_API_KEY).toBe("");
});

it("preserves a storage-close failure after normal stop", async () => {
  const harness = await buildLiveHarness({ requiredEnv: [] });
  const close = new Error("close failed");
  fixture.close.mockRejectedValueOnce(close);
  await expect(harness.close()).rejects.toBe(close);
  expect(fixture.stop).toHaveBeenCalledOnce();
  expect(process.env.OPENAI_API_KEY).toBe("");
});
