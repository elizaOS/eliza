/**
 * Unit coverage for rolodexProvider: static routing metadata, empty / missing
 * graph snapshots, person-line formatting (owner flag, platforms, aliases,
 * preferred channel, last-interaction date, fact count), snapshot-order
 * rendering, stats-driven header counts, and catch-path degradation when the
 * relationships service throws.
 *
 * The provider under test is real. Only the runtime collaborator
 * (getService → RelationshipsGraphService) is a typed in-memory fake so the
 * suite can drive getGraphSnapshot without a database.
 */
import type {
  IAgentRuntime,
  Memory,
  RelationshipsGraphSnapshot,
  RelationshipsPersonSummary,
  State,
  UUID,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { getValidationKeywordTerms } from "@elizaos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rolodexProvider } from "./rolodex.ts";

const EMPTY_STATE: State = { values: {}, data: {}, text: "" };
const GROUP_ID = "00000000-0000-4000-8000-0000000000a1" as UUID;
const ENTITY_A = "00000000-0000-4000-8000-0000000000b1" as UUID;
const ENTITY_B = "00000000-0000-4000-8000-0000000000b2" as UUID;

function message(): Memory {
  return {
    id: "00000000-0000-4000-8000-0000000000c1" as UUID,
    entityId: ENTITY_A,
    roomId: "00000000-0000-4000-8000-0000000000d1" as UUID,
    content: { text: "who do I know?" },
  } as Memory;
}

function makePerson(
  displayName: string,
  options: {
    primaryEntityId?: UUID;
    isOwner?: boolean;
    platforms?: string[];
    aliases?: string[];
    preferredCommunicationChannel?: string | null;
    lastInteractionAt?: string;
    factCount?: number;
  } = {},
): RelationshipsPersonSummary {
  const primaryEntityId = options.primaryEntityId ?? ENTITY_A;
  const person: RelationshipsPersonSummary = {
    groupId: GROUP_ID,
    primaryEntityId,
    memberEntityIds: [primaryEntityId],
    displayName,
    aliases: options.aliases ?? [],
    platforms: options.platforms ?? [],
    identities: [],
    emails: [],
    phones: [],
    websites: [],
    preferredCommunicationChannel:
      options.preferredCommunicationChannel ?? null,
    categories: [],
    tags: [],
    factCount: options.factCount ?? 0,
    relationshipCount: 0,
    isOwner: options.isOwner ?? false,
    profiles: [],
  };
  if (options.lastInteractionAt !== undefined) {
    person.lastInteractionAt = options.lastInteractionAt;
  }
  return person;
}

function makeSnapshot(
  people: RelationshipsPersonSummary[],
  stats: {
    totalPeople: number;
    totalRelationships: number;
    totalIdentities: number;
  } = {
    totalPeople: people.length,
    totalRelationships: 0,
    totalIdentities: people.length,
  },
): RelationshipsGraphSnapshot {
  return {
    people,
    relationships: [],
    stats,
    candidateMerges: [],
  };
}

function makeRuntime(
  graphService: { getGraphSnapshot: ReturnType<typeof vi.fn> } | null,
): IAgentRuntime {
  return {
    getService: vi.fn((name: string) => {
      if (name === "relationships") {
        return graphService;
      }
      return null;
    }),
  } as unknown as IAgentRuntime;
}

async function getRolodex(
  graphService: { getGraphSnapshot: ReturnType<typeof vi.fn> } | null,
) {
  return rolodexProvider.get(makeRuntime(graphService), message(), EMPTY_STATE);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rolodexProvider metadata", () => {
  it("declares ADMIN-gated, turn-scoped, contacts/memory routing", () => {
    expect(rolodexProvider.name).toBe("rolodex");
    expect(rolodexProvider.description).toBe(
      "Known contacts and relationships across all connected platforms (the Rolodex).",
    );
    expect(rolodexProvider.descriptionCompressed).toBe(
      "known contact relationship across connect platform (Rolodex)",
    );
    expect(rolodexProvider.dynamic).toBe(true);
    expect(rolodexProvider.position).toBe(7);
    expect(rolodexProvider.contexts).toEqual(["contacts", "memory"]);
    expect(rolodexProvider.contextGate).toEqual({
      anyOf: ["contacts", "memory"],
    });
    expect(rolodexProvider.cacheStable).toBe(false);
    expect(rolodexProvider.cacheScope).toBe("turn");
    expect(rolodexProvider.roleGate).toEqual({ minRole: "ADMIN" });
  });

  it("loads relevance keywords across all locales", () => {
    const allLocales = getValidationKeywordTerms("provider.rolodex.relevance", {
      includeAllLocales: true,
    });
    const defaultLocale = getValidationKeywordTerms(
      "provider.rolodex.relevance",
    );

    expect(rolodexProvider.relevanceKeywords).toEqual(allLocales);
    expect(allLocales).toEqual(expect.arrayContaining(defaultLocale));
    expect(allLocales.length).toBeGreaterThan(defaultLocale.length);
    expect(allLocales).toEqual(
      expect.arrayContaining(["rolodex", "contact", "谁", "연락처"]),
    );
  });
});

describe("rolodexProvider.get", () => {
  it("returns empty context when the relationships service is absent", async () => {
    const runtime = makeRuntime(null);
    const result = await rolodexProvider.get(runtime, message(), EMPTY_STATE);

    expect(runtime.getService).toHaveBeenCalledWith("relationships");
    expect(result).toEqual({ text: "", values: {}, data: {} });
  });

  it("renders the empty-state copy when the snapshot is null", async () => {
    const getGraphSnapshot = vi.fn(async () => null);
    const result = await getRolodex({ getGraphSnapshot });

    expect(getGraphSnapshot).toHaveBeenCalledWith({});
    expect(result).toEqual({
      text: "Rolodex: No known contacts yet.",
      values: { rolodexCount: 0 },
      data: { contacts: [] },
    });
  });

  it("renders the empty-state copy and forwards stats when people is empty", async () => {
    const snapshot = makeSnapshot([], {
      totalPeople: 0,
      totalRelationships: 3,
      totalIdentities: 0,
    });
    const getGraphSnapshot = vi.fn(async () => snapshot);
    const result = await getRolodex({ getGraphSnapshot });

    expect(result).toEqual({
      text: "Rolodex: No known contacts yet.",
      values: { rolodexCount: 0 },
      data: { contacts: [], stats: snapshot.stats },
    });
  });

  it("formats a single contact with empty platforms and omitted optional fields", async () => {
    const person = makePerson("Ada Lovelace");
    const snapshot = makeSnapshot([person], {
      totalPeople: 1,
      totalRelationships: 0,
      totalIdentities: 1,
    });
    const result = await getRolodex({
      getGraphSnapshot: vi.fn(async () => snapshot),
    });

    expect(result.text).toBe(
      [
        "Rolodex (1 contacts, 1 identities):",
        "- Ada Lovelace (no platforms)",
      ].join("\n"),
    );
    expect(result.values).toEqual({
      rolodexCount: 1,
      rolodexIdentityCount: 1,
    });
    expect(result.data).toEqual({ contacts: [person], stats: snapshot.stats });
  });

  it("marks the owner, joins platforms, and includes prefers/aka/last/facts", async () => {
    const person = makePerson("Shaw", {
      isOwner: true,
      platforms: ["discord", "telegram"],
      preferredCommunicationChannel: "telegram",
      aliases: ["lalalune", "shaw"],
      lastInteractionAt: "2026-08-23T18:41:00.000Z",
      factCount: 4,
    });
    const result = await getRolodex({
      getGraphSnapshot: vi.fn(async () => makeSnapshot([person])),
    });

    expect(result.text).toContain(
      "- Shaw [OWNER] (discord, telegram) | prefers: telegram | aka: lalalune, shaw | last: 2026-08-23 | 4 facts",
    );
  });

  it("omits fact count when it is zero and still truncates a short last-interaction stamp", async () => {
    const person = makePerson("Grace Hopper", {
      platforms: ["email"],
      lastInteractionAt: "2024-01",
      factCount: 0,
    });
    const result = await getRolodex({
      getGraphSnapshot: vi.fn(async () => makeSnapshot([person])),
    });

    expect(result.text).toBe(
      [
        "Rolodex (1 contacts, 1 identities):",
        "- Grace Hopper (email) | last: 2024-01",
      ].join("\n"),
    );
    expect(result.text).not.toContain("facts");
  });

  it("preserves snapshot order and uses stats counts even when they disagree with people.length", async () => {
    const first = makePerson("First", {
      primaryEntityId: ENTITY_A,
      platforms: ["discord"],
    });
    const second = makePerson("Second", {
      primaryEntityId: ENTITY_B,
      platforms: ["telegram"],
    });
    const snapshot = makeSnapshot([first, second], {
      totalPeople: 9,
      totalRelationships: 2,
      totalIdentities: 14,
    });
    const result = await getRolodex({
      getGraphSnapshot: vi.fn(async () => snapshot),
    });

    const lines = result.text?.split("\n") ?? [];
    expect(lines[0]).toBe("Rolodex (9 contacts, 14 identities):");
    expect(lines[1]).toBe("- First (discord)");
    expect(lines[2]).toBe("- Second (telegram)");
    expect(result.values).toEqual({
      rolodexCount: 9,
      rolodexIdentityCount: 14,
    });
    expect(result.data?.contacts).toEqual([first, second]);
  });

  it("returns empty context and logs the message when getGraphSnapshot throws an Error", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const result = await getRolodex({
      getGraphSnapshot: vi.fn(async () => {
        throw new Error("graph store unavailable");
      }),
    });

    expect(result).toEqual({ text: "", values: {}, data: {} });
    expect(errorSpy).toHaveBeenCalledWith(
      "[rolodex] Error:",
      "graph store unavailable",
    );
  });

  it("stringifies a non-Error throw and still degrades to empty context", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const result = await getRolodex({
      getGraphSnapshot: vi.fn(async () => {
        throw "not an error object";
      }),
    });

    expect(result).toEqual({ text: "", values: {}, data: {} });
    expect(errorSpy).toHaveBeenCalledWith(
      "[rolodex] Error:",
      "not an error object",
    );
  });

  it("degrades to empty context when a malformed snapshot throws while reading people", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const result = await getRolodex({
      getGraphSnapshot: vi.fn(async () => ({})),
    });

    expect(result).toEqual({ text: "", values: {}, data: {} });
    expect(errorSpy).toHaveBeenCalledWith(
      "[rolodex] Error:",
      expect.any(String),
    );
  });
});
