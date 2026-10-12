/**
 * Tests that ENTITY name-based contact resolution refuses ambiguous name or
 * handle fragments before any durable write, exercising the real
 * `entityAction` handler with a prototype-spied `LifeOpsService`.
 */
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lifeops/access.js", () => ({
  hasLifeOpsAccess: async () => true,
}));

import { LifeOpsService } from "../lifeops/service.js";
import { entityAction } from "./entity.js";

const AGENT_ID = "00000000-0000-4000-8000-000000000001" as UUID;
const OWNER_ID = "00000000-0000-4000-8000-000000000002" as UUID;
const ROOM_ID = "00000000-0000-4000-8000-000000000003" as UUID;

function relationship(id: string, name: string, handle: string) {
  return {
    id,
    agentId: AGENT_ID,
    name,
    primaryChannel: "email",
    primaryHandle: handle,
    email: handle,
    phone: null,
    notes: "",
    tags: [],
    relationshipType: "friend",
    lastContactedAt: null,
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeRuntime(): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return {
    agentId: AGENT_ID,
    getSetting: () => undefined,
    getCache: async (key: string) => cache.get(key),
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    },
    deleteCache: async (key: string) => cache.delete(key),
    reportError: () => undefined,
  } as unknown as IAgentRuntime;
}

function makeMessage(text: string): Memory {
  return {
    id: crypto.randomUUID() as UUID,
    entityId: OWNER_ID,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    content: { text, source: "test" },
  } as Memory;
}

async function logInteractionByName(
  runtime: IAgentRuntime,
  name: string,
): Promise<{ interactionRelationshipId: string | null; error?: string }> {
  const result = (await entityAction.handler(
    runtime,
    makeMessage(`log the interaction with ${name}`),
    undefined,
    { parameters: { action: "log_interaction", name } },
  )) as {
    success: boolean;
    data?: {
      error?: string;
      interaction?: { relationshipId: string };
    };
  };
  return {
    interactionRelationshipId: result.data?.interaction?.relationshipId ?? null,
    error: result.data?.error,
  };
}

describe("ENTITY name resolution fails closed on ambiguous fragments", () => {
  let listSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    listSpy = vi
      .spyOn(LifeOpsService.prototype, "listRelationships")
      .mockResolvedValue([
        relationship("rel-ann", "Ann", "ann@example.test"),
        relationship("rel-annette", "Annette", "annette@example.test"),
      ] as never);
    vi.spyOn(LifeOpsService.prototype, "getRelationship").mockImplementation(
      async (id: string) => {
        const known: Record<string, [string, string]> = {
          "rel-ann": ["Ann", "ann@example.test"],
          "rel-annette": ["Annette", "annette@example.test"],
        };
        const hit = known[id];
        return hit ? (relationship(id, hit[0], hit[1]) as never) : null;
      },
    );
    logSpy = vi
      .spyOn(LifeOpsService.prototype, "logInteraction")
      .mockImplementation(async (input) => {
        const record = input as { relationshipId: string };
        return {
          id: "int-1",
          agentId: AGENT_ID,
          createdAt: "2026-10-12T00:00:00.000Z",
          ...record,
        } as never;
      });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("still resolves an exact name and a single fragment match", async () => {
    const runtime = makeRuntime();

    const exact = await logInteractionByName(runtime, "ann");
    expect(exact.interactionRelationshipId).toBe("rel-ann");

    const fragment = await logInteractionByName(runtime, "annet");
    expect(fragment.interactionRelationshipId).toBe("rel-annette");
  });

  it("does not write when a handle fragment matches several contacts", async () => {
    const runtime = makeRuntime();
    const outcome = await logInteractionByName(runtime, "an");

    expect(outcome.interactionRelationshipId).toBeNull();
    expect(outcome.error).toBe("MISSING_EDGE_ID");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("does not write when several contacts share the exact requested name", async () => {
    listSpy.mockResolvedValue([
      relationship("rel-ann-a", "Ann", "ann.a@example.test"),
      relationship("rel-ann-b", "Ann", "ann.b@example.test"),
    ] as never);
    vi.spyOn(LifeOpsService.prototype, "getRelationship").mockImplementation(
      async (id: string) => {
        const known: Record<string, [string, string]> = {
          "rel-ann-a": ["Ann", "ann.a@example.test"],
          "rel-ann-b": ["Ann", "ann.b@example.test"],
        };
        const hit = known[id];
        return hit ? (relationship(id, hit[0], hit[1]) as never) : null;
      },
    );
    const runtime = makeRuntime();
    const outcome = await logInteractionByName(runtime, "ann");

    expect(outcome.interactionRelationshipId).toBeNull();
    expect(outcome.error).toBe("MISSING_EDGE_ID");
    expect(logSpy).not.toHaveBeenCalled();
  });
});
