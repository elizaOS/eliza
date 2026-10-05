/** Exercises live registry admission for routing without running domain actions or providers. */
import {
  AgentRuntime,
  ChannelType,
  type Memory,
  type State,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  formatAvailableContextsForPrompt,
  listAvailableContextsForTurn,
} from "./context-catalog";

const state: State = { text: "", values: {}, data: {} };

describe("capability-backed routing contexts", () => {
  it.each([ChannelType.DM, ChannelType.VOICE_DM])(
    "refreshes available domains without effects for %s",
    async (channelType) => {
      const runtime = new AgentRuntime({
        character: { name: "Routing admission", bio: "test" },
        logLevel: "fatal",
      });
      runtime.contexts.registerMany([
        { id: "simple" },
        { id: "notes", description: "Saved notes." },
        { id: "calendar" },
        { id: "health" },
        { id: "finance", roleGate: { minRole: "OWNER" } },
      ]);
      let available = true;
      let effects = 0;
      runtime.actions.push({
        name: "NOTES_LIST",
        description: "Read saved notes",
        contexts: ["notes"],
        validate: async () => available,
        handler: async () => {
          effects++;
          return { success: true };
        },
      });
      runtime.providers.push({
        name: "HEALTH_RECORDS",
        contexts: ["health"],
        roleGate: { minRole: "ADMIN" },
        get: async () => {
          effects++;
          return { text: "Complete health records" };
        },
      });
      runtime.providers.push({
        name: "RESTRICTED_CALENDAR",
        contextGate: { allOf: ["calendar", "finance"] },
        get: async () => {
          effects++;
          return { text: "Private combined records" };
        },
      });
      const message: Memory = {
        id: "10000000-0000-4000-8000-000000000001" as UUID,
        entityId: runtime.agentId,
        roomId: "10000000-0000-4000-8000-000000000002" as UUID,
        content: { text: "hello", channelType },
      };
      expect(
        (
          await listAvailableContextsForTurn(runtime, message, state, "ADMIN")
        ).map(({ id }) => id),
      ).toEqual(["simple", "notes", "health"]);
      available = false;
      expect(
        (
          await listAvailableContextsForTurn(runtime, message, state, "USER")
        ).map(({ id }) => id),
      ).toEqual(["simple"]);
      expect(effects).toBe(0);
    },
  );

  it("renders complete authored routing descriptions without changing registry evidence", () => {
    const definition = {
      id: "notes",
      label: "Notes",
      aliases: ["sticky"],
      description: "Saved notes.\nKeep exact Ω text.",
      sensitivity: "personal" as const,
    };
    const original = structuredClone(definition);
    expect(formatAvailableContextsForPrompt([definition])).toBe(
      "- notes: Saved notes.\nKeep exact Ω text.",
    );
    expect(definition).toEqual(original);
  });
});
