import { afterEach, expect, it, vi } from "vitest";
import { createMockRuntime } from "../../src/mock-runtime.ts";
import { applyScenarioSeedStep } from "./seeds.ts";

const repository = vi.hoisted(() => ({
  bootstrap: vi.fn().mockResolvedValue(undefined),
  reminder: vi.fn().mockResolvedValue(undefined),
  task: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@elizaos/plugin-personal-assistant/lifeops/index", () => ({
  LifeOpsRepository: class {
    static bootstrapSchema = repository.bootstrap;
    createReminderAttempt = repository.reminder;
    upsertScheduledTask = repository.task;
  },
}));
afterEach(() => vi.clearAllMocks());

it("persists canonical reminder channels while preserving the authored transport", async () => {
  const write = repository.reminder;
  const runtime = createMockRuntime({
    createMemory: vi
      .fn()
      .mockResolvedValue("00000000-0000-0000-0000-000000000001"),
  });
  for (const channel of [
    "desktop",
    "mobile",
    "ntfy",
    "sms",
    "voice",
    "in_app",
  ]) {
    expect(
      await applyScenarioSeedStep(
        { runtime, actionsCalled: [], now: "2030-01-01T00:00:00Z" },
        {
          type: "memory",
          content: {
            kind: "push-delivery-attempt",
            title: "Remember",
            channel,
          },
        },
      ),
    ).toBeUndefined();
    expect(write.mock.lastCall?.[0]).toMatchObject({
      channel: ["desktop", "mobile", "ntfy"].includes(channel)
        ? "push"
        : channel,
      deliveryMetadata: { channel },
    });
  }
});

it("uses a supported scheduler source and retains scenario provenance", async () => {
  const write = repository.task;
  const runtime = createMockRuntime({
    createMemory: vi
      .fn()
      .mockResolvedValue("00000000-0000-0000-0000-000000000001"),
  });
  expect(
    await applyScenarioSeedStep(
      {
        runtime,
        actionsCalled: [],
        scenarioId: "seed-contract",
        primaryRoomId: runtime.agentId,
        primaryUserId: runtime.agentId,
      },
      {
        type: "memory",
        content: { kind: "open-decision", title: "Choose a time" },
      },
    ),
  ).toBeUndefined();
  expect(write.mock.lastCall?.[1]).toMatchObject({
    kind: "approval",
    source: "plugin",
    metadata: { source: "scenario-seed", scenarioId: "seed-contract" },
  });
});
