import type { AgentRuntime, UUID } from "@elizaos/core";
import type { ScenarioSeedStep } from "@elizaos/scenario-runner/schema";
import { describe, expect, it, vi } from "vitest";
import { applyScenarioSeedStep } from "./seeds";

function createSeedRuntime() {
  const relationships = {
    getContact: vi.fn(async () => null),
    addContact: vi.fn(async () => ({})),
    updateContact: vi.fn(async () => ({})),
    addHandle: vi.fn(async () => ({})),
    recordInteraction: vi.fn(async () => ({})),
    setRelationshipGoal: vi.fn(async () => ({})),
  };
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001" as UUID,
    getService: vi.fn(() => relationships),
    getEntityById: vi.fn(async () => null),
    createEntity: vi.fn(async () => ({})),
  } as unknown as AgentRuntime;
  return { runtime, relationships };
}

describe("scenario seeds", () => {
  it("maps rolodex-entity memory seeds into relationship contacts", async () => {
    const { runtime, relationships } = createSeedRuntime();

    const result = await applyScenarioSeedStep({ actionsCalled: [], runtime }, {
      type: "memory",
      content: {
        kind: "rolodex-entity",
        id: "ent-acme-buyer",
        displayName: "Tomas Reyes",
        company: "Acme Inc.",
        tags: ["vip"],
        handles: [{ platform: "gmail", handle: "tomas.reyes@acme.com" }],
      },
    } satisfies ScenarioSeedStep);

    expect(result).toBeUndefined();
    expect(runtime.createEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        names: ["Tomas Reyes"],
      }),
    );
    expect(relationships.addContact).toHaveBeenCalledWith(
      expect.any(String),
      ["acquaintance"],
      expect.objectContaining({
        notes: expect.stringContaining("Company: Acme Inc."),
      }),
      { displayName: "Tomas Reyes" },
    );
    expect(relationships.addHandle).toHaveBeenCalledWith(expect.any(String), {
      platform: "gmail",
      identifier: "tomas.reyes@acme.com",
      displayLabel: undefined,
      isPrimary: undefined,
    });
    expect(relationships.updateContact).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        tags: ["vip"],
        relationshipStatus: "active",
      }),
    );
  });

  it("maps direct rolodex platform handles and recent news", async () => {
    const { runtime, relationships } = createSeedRuntime();

    const result = await applyScenarioSeedStep({ actionsCalled: [], runtime }, {
      type: "memory",
      content: {
        kind: "rolodex-entity",
        name: "Alex Rivera",
        primaryChannel: "telegram",
        telegramHandle: "@arivera",
        recentNews: "promoted to VP Engineering at Acme",
      },
    } satisfies ScenarioSeedStep);

    expect(result).toBeUndefined();
    expect(relationships.addHandle).toHaveBeenCalledWith(expect.any(String), {
      platform: "telegram",
      identifier: "@arivera",
      displayLabel: "Alex Rivera",
      isPrimary: true,
    });
    expect(relationships.addContact).toHaveBeenCalledWith(
      expect.any(String),
      ["acquaintance"],
      expect.objectContaining({
        notes: expect.stringContaining(
          "Recent news: promoted to VP Engineering at Acme",
        ),
      }),
      { displayName: "Alex Rivera" },
    );
  });

  it("continues to ignore unsupported memory seed kinds", async () => {
    const { runtime, relationships } = createSeedRuntime();

    const result = await applyScenarioSeedStep({ actionsCalled: [], runtime }, {
      type: "memory",
      content: {
        kind: "inbound-message",
        text: "hello",
      },
    } satisfies ScenarioSeedStep);

    expect(result).toBeUndefined();
    expect(runtime.getService).not.toHaveBeenCalled();
    expect(relationships.addContact).not.toHaveBeenCalled();
  });
});
