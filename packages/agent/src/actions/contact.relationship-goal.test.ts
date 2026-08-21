/**
 * CONTACT relationship-goal tests use a recording RelationshipsService seam
 * to prove exact durable-operation dispatch, ambiguity handling, and cadence
 * validation without substituting planner prose for state changes.
 */

import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { contactAction } from "./contact.ts";

const AGENT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as UUID;
const CONTACT_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" as UUID;
const ROOM_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc" as UUID;

function makeRuntime(overrides?: {
  matches?: Array<{ entityId: UUID }>;
  progress?: "on-track" | "overdue";
}) {
  const matches = overrides?.matches ?? [{ entityId: CONTACT_ID }];
  const setRelationshipGoal = vi.fn(
    async (
      _contactId: UUID,
      goal: { goalText: string; targetCadenceDays?: number },
    ) => ({ ...goal, setAt: "2026-08-18T00:00:00.000Z" }),
  );
  const getRelationshipProgress = vi.fn(async (contactId: UUID) => ({
    contactId,
    goal: { goalText: "Stay in touch", targetCadenceDays: 90 },
    lastInteractionAt: "2026-05-01T00:00:00.000Z",
    cadenceHealth: overrides?.progress ?? ("overdue" as const),
    daysSinceInteraction: 109,
    targetCadenceDays: 90,
  }));
  const importContactsFromPlatform = vi.fn(
    async (_platform: string, contacts: unknown[]) => ({
      imported: contacts,
      linkedToExisting: [],
      skipped: [],
    }),
  );
  const relationships = {
    searchContacts: vi.fn(async () => matches),
    getContact: vi.fn(async () => ({})),
    setRelationshipGoal,
    getRelationshipProgress,
    importContactsFromPlatform,
  };
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "Eliza" },
    getSetting: () => undefined,
    getService: (type: string) =>
      type === "relationships" ? relationships : null,
    getSearchCategory: () => {
      throw new Error("not registered");
    },
    registerSearchCategory: () => undefined,
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  return {
    runtime,
    relationships,
    setRelationshipGoal,
    getRelationshipProgress,
    importContactsFromPlatform,
  };
}

function message(): Memory {
  return {
    id: "dddddddd-dddd-dddd-dddd-dddddddddddd" as UUID,
    entityId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" as UUID,
    roomId: ROOM_ID,
    content: { text: "relationship goal", source: "dashboard" },
  } as Memory;
}

async function invoke(
  runtime: IAgentRuntime,
  parameters: Record<string, unknown>,
) {
  const result = await contactAction.handler(runtime, message(), undefined, {
    parameters,
  } as never);
  if (!result) throw new Error("handler returned no result");
  return result;
}

describe("CONTACT relationship goals", () => {
  it("persists a goal against the exactly resolved contact", async () => {
    const { runtime, setRelationshipGoal } = makeRuntime();
    const result = await invoke(runtime, {
      action: "set_goal",
      name: "Alice Chen",
      goalText: "Stay in touch every quarter",
      targetCadenceDays: 90,
    });

    expect(setRelationshipGoal).toHaveBeenCalledWith(CONTACT_ID, {
      goalText: "Stay in touch every quarter",
      targetCadenceDays: 90,
    });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      actionName: "CONTACT",
      op: "set_goal",
      contactId: CONTACT_ID,
      goal: { targetCadenceDays: 90 },
    });
  });

  it("reads structured cadence progress", async () => {
    const { runtime, getRelationshipProgress } = makeRuntime();
    const result = await invoke(runtime, {
      action: "progress",
      entityId: CONTACT_ID,
    });

    expect(getRelationshipProgress).toHaveBeenCalledWith(CONTACT_ID);
    expect(result.data).toMatchObject({
      actionName: "CONTACT",
      op: "progress",
      progress: { cadenceHealth: "overdue", targetCadenceDays: 90 },
    });
  });

  it("fails closed when a name is ambiguous", async () => {
    const { runtime, setRelationshipGoal } = makeRuntime({
      matches: [
        { entityId: CONTACT_ID },
        { entityId: "ffffffff-ffff-ffff-ffff-ffffffffffff" as UUID },
      ],
    });
    const result = await invoke(runtime, {
      action: "set_goal",
      name: "Alex",
      goalText: "Stay in touch",
    });

    expect(result.values?.error).toBe("AMBIGUOUS_CONTACT");
    expect(setRelationshipGoal).not.toHaveBeenCalled();
  });

  it("rejects invalid cadence before touching durable state", async () => {
    const { runtime, setRelationshipGoal } = makeRuntime();
    const result = await invoke(runtime, {
      action: "set_goal",
      name: "Alice Chen",
      goalText: "Stay in touch",
      targetCadenceDays: 0,
    });

    expect(result.values?.error).toBe("INVALID_CADENCE");
    expect(setRelationshipGoal).not.toHaveBeenCalled();
  });

  it("imports only a validated single-platform roster", async () => {
    const { runtime, importContactsFromPlatform } = makeRuntime();
    const result = await invoke(runtime, {
      action: "import",
      platform: "discord",
      contacts: [
        { identifier: "user-1", displayName: "Priya Rao" },
        { platform: "discord", identifier: "user-2", displayName: "Mira Wu" },
      ],
    });

    expect(importContactsFromPlatform).toHaveBeenCalledWith("discord", [
      { platform: "discord", identifier: "user-1", displayName: "Priya Rao" },
      { platform: "discord", identifier: "user-2", displayName: "Mira Wu" },
    ]);
    expect(result.data).toMatchObject({
      actionName: "CONTACT",
      op: "import",
      platform: "discord",
      requestedCount: 2,
      importedCount: 2,
      linkedCount: 0,
      skippedCount: 0,
    });
  });

  it("rejects mixed-platform roster entries", async () => {
    const { runtime, importContactsFromPlatform } = makeRuntime();
    const result = await invoke(runtime, {
      action: "import",
      platform: "discord",
      contacts: [{ platform: "telegram", identifier: "user-1" }],
    });

    expect(result.values?.error).toBe("INVALID_CONTACT");
    expect(importContactsFromPlatform).not.toHaveBeenCalled();
  });

  it("rejects malformed optional roster fields instead of dropping them", async () => {
    const { runtime, importContactsFromPlatform } = makeRuntime();
    const result = await invoke(runtime, {
      action: "import",
      platform: "discord",
      contacts: [
        {
          identifier: "user-1",
          displayName: 42,
          categories: ["friend", 7],
        },
      ],
    });

    expect(result.values?.error).toBe("INVALID_CONTACT");
    expect(importContactsFromPlatform).not.toHaveBeenCalled();
  });
});
