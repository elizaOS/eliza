import type { IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { markFollowupDoneAction } from "./markFollowupDone.js";

const ANN_ID = "11111111-1111-4111-8111-111111111111" as UUID;
const JOANNE_ID = "22222222-2222-4222-8222-222222222222" as UUID;
const NAMES: Record<string, string> = {
  [ANN_ID]: "Ann Lee",
  [JOANNE_ID]: "Joanne Park",
};

function makeRuntime(updated: string[]) {
  const contacts = Object.entries(NAMES).map(([entityId, displayName]) => ({
    entityId: entityId as UUID,
    customFields: { displayName },
    interactions: [],
  }));
  const service = {
    searchContacts: async () => contacts,
    getContact: async (id: UUID) =>
      contacts.find((c) => c.entityId === id) ?? null,
    updateContact: async (id: UUID) => {
      updated.push(id);
    },
  };
  return {
    getService: (name: string) => (name === "relationships" ? service : null),
    getEntityById: async (id: UUID) => ({
      names: [NAMES[id] ?? String(id)],
    }),
  } as unknown as IAgentRuntime;
}

async function run(contactName: string) {
  const updated: string[] = [];
  const result = await markFollowupDoneAction.handler(
    makeRuntime(updated),
    { content: { text: "probe" } } as never,
    undefined,
    { parameters: { contactName } } as never,
  );
  return { result, updated };
}

describe("MARK_FOLLOWUP_DONE contact-name resolution", () => {
  it("prefers the whole-word name over a substring-only name", async () => {
    const { result, updated } = await run("Ann");
    expect(result.success).toBe(true);
    expect(updated).toEqual([ANN_ID]);
  });

  it("keeps substring fragments working when no whole-word hit exists", async () => {
    const { result, updated } = await run("Joann");
    expect(result.success).toBe(true);
    expect(updated).toEqual([JOANNE_ID]);
  });
});
