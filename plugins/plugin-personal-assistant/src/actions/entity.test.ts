/**
 * Tests that ENTITY interaction logging resolves a contact only when the
 * message names that contact as whole words, exercising the real
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
    primaryChannel: "imessage",
    primaryHandle: handle,
    email: null,
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

async function logInteractionFor(
  runtime: IAgentRuntime,
  text: string,
): Promise<{ interactionRelationshipId: string | null; result: unknown }> {
  const result = (await entityAction.handler(
    runtime,
    makeMessage(text),
    undefined,
    { parameters: { action: "log_interaction" } },
  )) as {
    success: boolean;
    data?: {
      error?: string;
      interaction?: { relationshipId: string };
    };
  };
  return {
    interactionRelationshipId: result.data?.interaction?.relationshipId ?? null,
    result,
  };
}

describe("ENTITY log_interaction resolves the named contact only", () => {
  let listSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    listSpy = vi
      .spyOn(LifeOpsService.prototype, "listRelationships")
      .mockResolvedValue([
        relationship("rel-ann", "Ann", "ann@example.com"),
        relationship("rel-anna-lee", "Anna Lee", "anna.lee@example.com"),
      ] as never);
    vi.spyOn(LifeOpsService.prototype, "getRelationship").mockImplementation(
      async (id: string) => {
        const known: Record<string, [string, string]> = {
          "rel-ann": ["Ann", "ann@example.com"],
          "rel-anna-lee": ["Anna Lee", "anna.lee@example.com"],
          "rel-bob": ["Bob", "bob@example.com"],
          "rel-bob-jones": ["Bob Jones", "bob.jones@example.com"],
          "rel-tanaka": ["田中", "+819012345678"],
          "rel-sakura": ["さくら", "+819012345680"],
          "rel-kim": ["김철수", "+821012345678"],
          "rel-tanaka-katakana": ["タナカ", "+819012345679"],
          "rel-zhang-san": ["张三", "+8613800138000"],
        };
        const hit = known[id];
        return hit ? (relationship(id, hit[0], hit[1]) as never) : null;
      },
    );
    vi.spyOn(LifeOpsService.prototype, "logInteraction").mockImplementation(
      async (input) => {
        const record = input as { relationshipId: string };
        return {
          id: "int-1",
          agentId: AGENT_ID,
          createdAt: "2026-10-12T00:00:00.000Z",
          ...record,
        } as never;
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs the interaction with the fully named contact, not a name it contains", async () => {
    const runtime = makeRuntime();
    const { interactionRelationshipId } = await logInteractionFor(
      runtime,
      "anna lee can't make it tomorrow, log that we rescheduled",
    );

    expect(interactionRelationshipId).toBe("rel-anna-lee");
  });

  it("prefers the contact whose whole name was given over a name it contains", async () => {
    listSpy.mockResolvedValue([
      relationship("rel-bob", "Bob", "bob@example.com"),
      relationship("rel-bob-jones", "Bob Jones", "bob.jones@example.com"),
    ] as never);
    const runtime = makeRuntime();
    const { interactionRelationshipId } = await logInteractionFor(
      runtime,
      "bob jones picked up the documents today",
    );

    expect(interactionRelationshipId).toBe("rel-bob-jones");
  });

  it("does not log an interaction when the text only contains a name inside another word", async () => {
    const runtime = makeRuntime();
    const { result } = await logInteractionFor(
      runtime,
      "annual planning moved to 3pm",
    );

    expect((result as { data?: { error?: string } }).data?.error).toBe(
      "MISSING_EDGE_ID",
    );
  });

  it("still logs a whole-name mention", async () => {
    const runtime = makeRuntime();
    const { interactionRelationshipId } = await logInteractionFor(
      runtime,
      "log that I had coffee with anna lee",
    );

    expect(interactionRelationshipId).toBe("rel-anna-lee");
  });

  it("still resolves an unspaced-script name through attached particles", async () => {
    listSpy.mockResolvedValue([
      relationship("rel-tanaka", "田中", "+819012345678"),
    ] as never);
    const runtime = makeRuntime();
    const { interactionRelationshipId } = await logInteractionFor(
      runtime,
      "田中さんとの打ち合わせをログに残して",
    );

    expect(interactionRelationshipId).toBe("rel-tanaka");
  });

  it("does not pick one contact when the text names each separately", async () => {
    listSpy.mockResolvedValue([
      relationship("rel-bob", "Bob", "bob@example.com"),
      relationship("rel-bob-jones", "Bob Jones", "bob.jones@example.com"),
    ] as never);
    const runtime = makeRuntime();
    const { result } = await logInteractionFor(
      runtime,
      "Bob and Bob Jones reviewed the documents together",
    );

    expect((result as { data?: { error?: string } }).data?.error).toBe(
      "MISSING_EDGE_ID",
    );
  });

  it("does not resolve an unspaced-script name inside another name", async () => {
    listSpy.mockResolvedValue([
      relationship("rel-tanaka", "田中", "+819012345678"),
    ] as never);
    const runtime = makeRuntime();
    const { result } = await logInteractionFor(
      runtime,
      "山田中村さんとの打ち合わせをログに残して",
    );

    expect((result as { data?: { error?: string } }).data?.error).toBe(
      "MISSING_EDGE_ID",
    );
  });

  it("resolves a kana name with an attached honorific or particle", async () => {
    listSpy.mockResolvedValue([
      relationship("rel-sakura", "さくら", "+819012345680"),
    ] as never);
    const runtime = makeRuntime();
    const honorific = await logInteractionFor(
      runtime,
      "さくらさんとの打ち合わせをログに残して",
    );
    expect(honorific.interactionRelationshipId).toBe("rel-sakura");

    const particle = await logInteractionFor(runtime, "さくらと打ち合わせ");
    expect(particle.interactionRelationshipId).toBe("rel-sakura");
  });

  it("does not resolve a kana name inside a longer word", async () => {
    listSpy.mockResolvedValue([
      relationship("rel-sakura", "さくら", "+819012345680"),
    ] as never);
    const runtime = makeRuntime();
    const { result } = await logInteractionFor(runtime, "さくらんぼを食べた");

    expect((result as { data?: { error?: string } }).data?.error).toBe(
      "MISSING_EDGE_ID",
    );
  });

  it("resolves a Korean name with an attached honorific or particle", async () => {
    listSpy.mockResolvedValue([
      relationship("rel-kim", "김철수", "+821012345678"),
    ] as never);
    const runtime = makeRuntime();
    const honorific = await logInteractionFor(runtime, "김철수님과 미팅");
    expect(honorific.interactionRelationshipId).toBe("rel-kim");

    const particle = await logInteractionFor(runtime, "김철수에게 메일 보내줘");
    expect(particle.interactionRelationshipId).toBe("rel-kim");
  });

  it("still resolves a katakana name through attached particles", async () => {
    listSpy.mockResolvedValue([
      relationship("rel-tanaka-katakana", "タナカ", "+819012345679"),
    ] as never);
    const runtime = makeRuntime();
    const { interactionRelationshipId } = await logInteractionFor(
      runtime,
      "タナカさんに連絡",
    );

    expect(interactionRelationshipId).toBe("rel-tanaka-katakana");
  });

  it("resolves a Chinese name through attached function characters", async () => {
    listSpy.mockResolvedValue([
      relationship("rel-zhang-san", "张三", "+8613800138000"),
    ] as never);
    const runtime = makeRuntime();
    const { interactionRelationshipId } = await logInteractionFor(
      runtime,
      "请记录今天和张三的午餐交流",
    );

    expect(interactionRelationshipId).toBe("rel-zhang-san");
  });

  it("resolves a Chinese name followed by a verb", async () => {
    listSpy.mockResolvedValue([
      relationship("rel-zhang-san", "张三", "+8613800138000"),
    ] as never);
    const runtime = makeRuntime();
    const { interactionRelationshipId } = await logInteractionFor(
      runtime,
      "请记录今天和张三吃饭的交流",
    );

    expect(interactionRelationshipId).toBe("rel-zhang-san");
  });

  it("does not resolve a Chinese name before an unlisted character", async () => {
    listSpy.mockResolvedValue([
      relationship("rel-zhang-san", "张三", "+8613800138000"),
    ] as never);
    const runtime = makeRuntime();
    const { result } = await logInteractionFor(
      runtime,
      "请记录今天和张三郊游的见闻",
    );

    expect((result as { data?: { error?: string } }).data?.error).toBe(
      "MISSING_EDGE_ID",
    );
  });

  it("does not resolve a Chinese name inside a longer name", async () => {
    listSpy.mockResolvedValue([
      relationship("rel-zhang-san", "张三", "+8613800138000"),
    ] as never);
    const runtime = makeRuntime();
    const { result } = await logInteractionFor(
      runtime,
      "请记录今天和张三丰的午餐交流",
    );

    expect((result as { data?: { error?: string } }).data?.error).toBe(
      "MISSING_EDGE_ID",
    );
  });
});
