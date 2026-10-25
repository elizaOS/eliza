/**
 * Tests that ENTITY structured-name resolution (through the real
 * `entityAction.handler`) never picks a list-order winner for a durable
 * interaction write: a tie inside any tier is ambiguous input and must fail
 * closed on every parameter that can carry it (`name` and non-id
 * `relationshipId` alike), while a unique match still resolves through its
 * own tier and an unmatched structured name still falls back to the
 * free-text token stage.
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

function relationship(
  id: string,
  name: string,
  handle: string,
  email: string | null = null,
) {
  return {
    id,
    agentId: AGENT_ID,
    name,
    primaryChannel: "imessage",
    primaryHandle: handle,
    email,
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

async function logNamedInteraction(
  runtime: IAgentRuntime,
  params: Record<string, unknown>,
  messageText = "please log this",
): Promise<{
  success: boolean;
  error: string | undefined;
  interactionRelationshipId: string | null;
}> {
  const result = (await entityAction.handler(
    runtime,
    makeMessage(messageText),
    undefined,
    { parameters: { action: "log_interaction", ...params } },
  )) as {
    success: boolean;
    data?: { error?: string; interaction?: { relationshipId: string } };
  };
  return {
    success: result.success,
    error: result.data?.error,
    interactionRelationshipId: result.data?.interaction?.relationshipId ?? null,
  };
}

describe("ENTITY structured-name resolution fails closed on ambiguity", () => {
  let loggedRelationshipIds: string[];
  let directory: Array<ReturnType<typeof relationship>>;

  beforeEach(() => {
    loggedRelationshipIds = [];
    vi.spyOn(LifeOpsService.prototype, "listRelationships").mockImplementation(
      async () => directory as never,
    );
    vi.spyOn(LifeOpsService.prototype, "getRelationship").mockImplementation(
      async (id: string) =>
        (directory.find((entry) => entry.id === id) ?? null) as never,
    );
    vi.spyOn(LifeOpsService.prototype, "logInteraction").mockImplementation(
      async (input) => {
        const record = input as { relationshipId: string };
        loggedRelationshipIds.push(record.relationshipId);
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

  it("prefers a whole name part over another contact's address substring", async () => {
    directory = [
      relationship("rel-bethann", "Bethann Cole", "bethann@example.test"),
      relationship("rel-ann", "Zoe Ann", "zoe@example.test"),
    ];
    const outcome = await logNamedInteraction(makeRuntime(), { name: "ann" });
    expect(outcome.interactionRelationshipId).toBe("rel-ann");
    expect(loggedRelationshipIds).toEqual(["rel-ann"]);
  });

  it("does not fall through a whole-name tie to a unique address", async () => {
    directory = [
      relationship("rel-ann-smith", "Ann Smith", "ann@example.test"),
      relationship("rel-ann-jones", "Ann Jones", "jones@example.test"),
    ];
    const outcome = await logNamedInteraction(makeRuntime(), { name: "ann" });
    expect(outcome.success).toBe(false);
    expect(loggedRelationshipIds).toEqual([]);
  });

  it("keeps accented letters inside whole-name boundaries", async () => {
    directory = [
      relationship("rel-joanne", "Joanné", "joanne@example.test"),
      relationship("rel-ann", "Zoe Ann", "zoe@example.test"),
    ];
    const outcome = await logNamedInteraction(makeRuntime(), { name: "ann" });
    expect(outcome.interactionRelationshipId).toBe("rel-ann");
    expect(loggedRelationshipIds).toEqual(["rel-ann"]);
  });

  it("rejects a name fragment that two contacts share instead of logging the first", async () => {
    directory = [
      relationship("rel-ann-smith", "Ann Smith", "ann.smith@example.test"),
      relationship("rel-ann-jones", "Ann Jones", "ann.jones@example.test"),
    ];
    const outcome = await logNamedInteraction(makeRuntime(), { name: "ann" });
    expect(outcome.success).toBe(false);
    expect(outcome.error).toBe("MISSING_EDGE_ID");
    expect(loggedRelationshipIds).toEqual([]);
  });

  it("rejects two contacts that share the exact same name", async () => {
    directory = [
      relationship("rel-dup-1", "Ann Smith", "ann@work.example.test"),
      relationship("rel-dup-2", "Ann Smith", "ann@home.example.test"),
    ];
    const outcome = await logNamedInteraction(makeRuntime(), {
      name: "ann smith",
    });
    expect(outcome.success).toBe(false);
    expect(outcome.error).toBe("MISSING_EDGE_ID");
    expect(loggedRelationshipIds).toEqual([]);
  });

  it("rejects a name fragment that matches two contacts through handle or email", async () => {
    directory = [
      relationship("rel-zed", "Zed Zeta", "anna@example.test"),
      relationship(
        "rel-yan",
        "Yan York",
        "yan@example.test",
        "anna@example.test",
      ),
    ];
    const outcome = await logNamedInteraction(makeRuntime(), { name: "anna" });
    expect(outcome.success).toBe(false);
    expect(outcome.error).toBe("MISSING_EDGE_ID");
    expect(loggedRelationshipIds).toEqual([]);
  });

  it("still logs to the one contact a unique fragment identifies", async () => {
    directory = [
      relationship("rel-ann-smith", "Ann Smith", "ann.smith@example.test"),
      relationship("rel-bob", "Bob Jones", "bob@example.test"),
    ];
    const outcome = await logNamedInteraction(makeRuntime(), { name: "ann" });
    expect(outcome.success).toBe(true);
    expect(outcome.interactionRelationshipId).toBe("rel-ann-smith");
    expect(loggedRelationshipIds).toEqual(["rel-ann-smith"]);
  });

  it("still prefers the unique exact name over an address-tier match", async () => {
    directory = [
      relationship("rel-bob", "Bob", "ann.smith@example.test"),
      relationship("rel-ann-smith", "Ann Smith", "ann@example.test"),
    ];
    const outcome = await logNamedInteraction(makeRuntime(), {
      name: "ann smith",
    });
    expect(outcome.success).toBe(true);
    expect(outcome.interactionRelationshipId).toBe("rel-ann-smith");
    expect(loggedRelationshipIds).toEqual(["rel-ann-smith"]);
  });

  it("still resolves a name that uniquely matches one contact's email through the address tier", async () => {
    directory = [
      relationship(
        "rel-rebecca",
        "Rebecca Stone",
        "rebecca@example.test",
        "sarah@example.test",
      ),
      relationship("rel-marc", "Marc Polo", "marc@example.test"),
    ];
    const outcome = await logNamedInteraction(makeRuntime(), { name: "sarah" });
    expect(outcome.success).toBe(true);
    expect(outcome.interactionRelationshipId).toBe("rel-rebecca");
    expect(loggedRelationshipIds).toEqual(["rel-rebecca"]);
  });

  it("still resolves a name fragment unique to one contact's name through the name tier", async () => {
    directory = [
      relationship("rel-nadia", "Nadia Nour", "nadia@example.test"),
      relationship("rel-omar", "Omar Osei", "omar@example.test"),
    ];
    const outcome = await logNamedInteraction(makeRuntime(), { name: "nour" });
    expect(outcome.success).toBe(true);
    expect(outcome.interactionRelationshipId).toBe("rel-nadia");
    expect(loggedRelationshipIds).toEqual(["rel-nadia"]);
  });

  it("falls back to the free-text token stage when no structured tier matches", async () => {
    // "bobby jones" substring-matches no tier (the handle token "bobby" is
    // the only signal), so only the preserved free-text fallback may resolve
    // it; a zero-match tier is unmatched, never ambiguous.
    directory = [relationship("rel-bob", "Bob Jones", "@bobby")];
    const outcome = await logNamedInteraction(makeRuntime(), {
      name: "bobby jones",
    });
    expect(outcome.success).toBe(true);
    expect(outcome.interactionRelationshipId).toBe("rel-bob");
    expect(loggedRelationshipIds).toEqual(["rel-bob"]);
  });

  it("rejects a non-id relationshipId value that two contacts ambiguously share, even when the body names one of them", async () => {
    directory = [
      relationship("rel-ann-smith", "Ann Smith", "ann.smith@example.test"),
      relationship("rel-ann-jones", "Ann Jones", "ann.jones@example.test"),
    ];
    // The body uniquely names one Ann; the tie on the relationshipId alias
    // must still fail closed instead of laundering through the free-text
    // stage. Without the alias guard this message resolves to rel-ann-smith.
    const outcome = await logNamedInteraction(
      makeRuntime(),
      { relationshipId: "ann" },
      "send ann smith the deck",
    );
    expect(outcome.success).toBe(false);
    expect(outcome.error).toBe("MISSING_EDGE_ID");
    expect(loggedRelationshipIds).toEqual([]);
  });

  it("does not log to a contact whose handle merely contains the named fragment", async () => {
    // "anna" is a mid-segment substring of "joanna.bowman": resolving it
    // used to point the interaction at Joanna even though no Joanna was
    // named. A needle that is not a whole address part must stay unmatched.
    directory = [
      relationship(
        "rel-joanna",
        "Joanna Bowman",
        "joanna.bowman",
        "joanna.bowman@example.test",
      ),
    ];
    const outcome = await logNamedInteraction(makeRuntime(), { name: "anna" });
    expect(outcome.success).toBe(false);
    expect(outcome.error).toBe("MISSING_EDGE_ID");
    expect(loggedRelationshipIds).toEqual([]);
  });

  it("does not log to a contact whose name merely contains the named fragment", async () => {
    directory = [
      relationship("rel-susanna", "Susanna Reed", "susanna@example.test"),
    ];
    const outcome = await logNamedInteraction(makeRuntime(), { name: "anna" });
    expect(outcome.success).toBe(false);
    expect(outcome.error).toBe("MISSING_EDGE_ID");
    expect(loggedRelationshipIds).toEqual([]);
  });

  it("does not log to a contact whose name is only part of the named word", async () => {
    // "Ann" is inside "Joanna", "Hannah" and "Danny"; none of them names Ann.
    directory = [
      relationship("rel-ann", "Ann", "+15550000001"),
      relationship("rel-bob", "Bob Smith", "@bobsmith"),
    ];
    for (const name of ["Joanna", "Hannah", "Danny"]) {
      const outcome = await logNamedInteraction(makeRuntime(), { name });
      expect(outcome.success, name).toBe(false);
      expect(outcome.error, name).toBe("MISSING_EDGE_ID");
    }
    const fromBody = await logNamedInteraction(
      makeRuntime(),
      {},
      "had coffee with Joanna",
    );
    expect(fromBody.success).toBe(false);
    expect(loggedRelationshipIds).toEqual([]);
  });

  it("still logs from the message to the one contact it names as a whole word", async () => {
    directory = [
      relationship("rel-ann", "Ann", "+15550000001"),
      relationship("rel-bob", "Bob Smith", "@bobsmith"),
    ];
    const outcome = await logNamedInteraction(
      makeRuntime(),
      {},
      "had coffee with Ann today",
    );
    expect(outcome.interactionRelationshipId).toBe("rel-ann");
    expect(loggedRelationshipIds).toEqual(["rel-ann"]);
  });

  it("does not pick the first of two contacts the message names", async () => {
    directory = [
      relationship("rel-ann", "Ann", "+15550000001"),
      relationship("rel-bob", "Bob Smith", "@bobsmith"),
    ];
    const outcome = await logNamedInteraction(
      makeRuntime(),
      {},
      "had coffee with Ann and Bob Smith",
    );
    expect(outcome.success).toBe(false);
    expect(loggedRelationshipIds).toEqual([]);
  });

  it("still logs through the address tier for a whole handle or email", async () => {
    directory = [
      relationship(
        "rel-joanna",
        "Joanna Bowman",
        "joanna.bowman",
        "joanna.bowman@example.test",
      ),
    ];
    const byHandle = await logNamedInteraction(makeRuntime(), {
      name: "@joanna.bowman",
    });
    expect(byHandle.interactionRelationshipId).toBe("rel-joanna");
    const byEmail = await logNamedInteraction(makeRuntime(), {
      name: "joanna.bowman@example.test",
    });
    expect(byEmail.interactionRelationshipId).toBe("rel-joanna");
    expect(loggedRelationshipIds).toEqual(["rel-joanna", "rel-joanna"]);
  });

  it("still logs through the address tier for a separator-delimited handle part", async () => {
    // The contact's name never whole-part-matches "ann" ("Annette" blocks
    // it), so only the address tier can resolve this.
    directory = [
      relationship(
        "rel-annette",
        "Annette Greer",
        "the.ann.greene@example.test",
      ),
    ];
    const outcome = await logNamedInteraction(makeRuntime(), { name: "ann" });
    expect(outcome.success).toBe(true);
    expect(outcome.interactionRelationshipId).toBe("rel-annette");
    expect(loggedRelationshipIds).toEqual(["rel-annette"]);
  });
});
