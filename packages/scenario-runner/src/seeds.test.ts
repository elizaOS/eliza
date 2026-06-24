import type { AgentRuntime, UUID } from "@elizaos/core";
import type {
  ScenarioContext,
  ScenarioSeedStep,
} from "@elizaos/scenario-runner/schema";
import { describe, expect, it, vi } from "vitest";
import { applyScenarioSeedStep } from "./seeds";

function createSeedHarness() {
  const relationships = {
    getContact: vi.fn(async () => null),
    addContact: vi.fn(async () => undefined),
    updateContact: vi.fn(async () => undefined),
    addHandle: vi.fn(async () => undefined),
    recordInteraction: vi.fn(async () => undefined),
    setRelationshipGoal: vi.fn(async () => undefined),
  };
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001" as UUID,
    getService: vi.fn((serviceName: string) =>
      serviceName === "relationships" ? relationships : null,
    ),
    getEntityById: vi.fn(async () => null),
    createEntity: vi.fn(async () => undefined),
  } as unknown as AgentRuntime;
  return {
    ctx: { runtime } as ScenarioContext,
    relationships,
    runtime,
  };
}

describe("scenario seeds", () => {
  it("maps merged-entity memory seeds into relationship contacts with all handles", async () => {
    const { ctx, relationships, runtime } = createSeedHarness();

    const result = await applyScenarioSeedStep(ctx, {
      type: "memory",
      content: {
        kind: "merged-entity",
        id: "ent-alex-lee-merged",
        displayName: "Alex Lee",
        handles: [
          {
            platform: "gmail",
            handle: "alex.lee@quanta.com",
            realPerson: "alex-1",
          },
          {
            platform: "telegram",
            handle: "@alexlee",
            realPerson: "alex-2",
          },
        ],
        mergedAccidentally: true,
      },
    } as ScenarioSeedStep);

    expect(result).toBeUndefined();
    expect(runtime.createEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        names: ["Alex Lee"],
      }),
    );
    expect(relationships.addContact).toHaveBeenCalledWith(
      expect.any(String),
      ["merged-entity"],
      {
        notes:
          "Scenario entity id: ent-alex-lee-merged\n" +
          "Merged accidentally: true\n" +
          "gmail alex.lee@quanta.com real person: alex-1\n" +
          "telegram @alexlee real person: alex-2",
      },
      { displayName: "Alex Lee" },
    );
    const addedHandles = relationships.addHandle.mock.calls.map(
      (call) =>
        (
          call as unknown as [
            unknown,
            {
              platform: string;
              identifier: string;
            },
          ]
        )[1],
    );
    expect(addedHandles).toEqual([
      expect.objectContaining({
        platform: "gmail",
        identifier: "alex.lee@quanta.com",
      }),
      expect.objectContaining({
        platform: "telegram",
        identifier: "@alexlee",
      }),
    ]);
    expect(relationships.updateContact).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        relationshipStatus: "active",
        tags: ["merged-entity"],
      }),
    );
  });

  it("keeps direct platform handles and authored tags on merged-entity seeds", async () => {
    const { ctx, relationships } = createSeedHarness();

    await applyScenarioSeedStep(ctx, {
      type: "memory",
      content: {
        kind: "merged-entity",
        platform: "discord",
        handle: "priyam#0042",
        tags: ["vip", "studio"],
      },
    } as ScenarioSeedStep);

    expect(relationships.addHandle).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        platform: "discord",
        identifier: "priyam#0042",
      }),
    );
    expect(relationships.updateContact).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        tags: ["vip", "studio"],
      }),
    );
  });

  it("continues to ignore unsupported memory seed kinds", async () => {
    const { ctx, relationships, runtime } = createSeedHarness();

    const result = await applyScenarioSeedStep(ctx, {
      type: "memory",
      content: {
        kind: "inbound-message",
        text: "not a contact seed",
      },
    } as ScenarioSeedStep);

    expect(result).toBeUndefined();
    expect(runtime.getService).not.toHaveBeenCalled();
    expect(relationships.addContact).not.toHaveBeenCalled();
  });
});
