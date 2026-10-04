import { LifeOpsRepository } from "@elizaos/plugin-personal-assistant/lifeops/index";
import { afterEach, expect, it, vi } from "vitest";
import { createMockRuntime } from "../../src/mock-runtime.ts";
import { applyScenarioSeedStep } from "./seeds.ts";

afterEach(() => vi.restoreAllMocks());

it("persists canonical reminder channels while preserving the authored transport", async () => {
  vi.spyOn(LifeOpsRepository, "bootstrapSchema").mockResolvedValue();
  const write = vi
    .spyOn(LifeOpsRepository.prototype, "createReminderAttempt")
    .mockResolvedValue();
  const runtime = createMockRuntime();
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
  vi.spyOn(LifeOpsRepository, "bootstrapSchema").mockResolvedValue();
  const write = vi
    .spyOn(LifeOpsRepository.prototype, "upsertScheduledTask")
    .mockResolvedValue();
  const runtime = createMockRuntime();
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
