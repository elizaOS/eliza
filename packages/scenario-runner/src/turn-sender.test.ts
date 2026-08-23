/**
 * Verifies deterministic scenario sender identities and trusted bot metadata
 * without loading a runtime, model, or connector.
 */

import type { UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { resolveScenarioTurnSender } from "./turn-sender.ts";

const DEFAULT_ENTITY_ID = "00000000-0000-4000-8000-000000000001" as UUID;

describe("scenario turn sender resolution", () => {
  it("preserves the room principal when no authored sender is declared", () => {
    expect(
      resolveScenarioTurnSender({
        scenarioId: "sender-resolution",
        source: "discord",
        defaultEntityId: DEFAULT_ENTITY_ID,
      }),
    ).toEqual({ entityId: DEFAULT_ENTITY_ID, metadata: {} });
  });

  it("stamps distinct principals and trusted bot authorship", () => {
    const human = resolveScenarioTurnSender({
      scenarioId: "sender-resolution",
      source: "discord",
      defaultEntityId: DEFAULT_ENTITY_ID,
      sender: { id: "dee-42", name: "Dee", kind: "human" },
    });
    const bot = resolveScenarioTurnSender({
      scenarioId: "sender-resolution",
      source: "discord",
      defaultEntityId: DEFAULT_ENTITY_ID,
      sender: { id: "quill-7", name: "Quill", kind: "bot" },
    });

    expect(human.entityId).not.toBe(bot.entityId);
    expect(human.metadata).toEqual({
      entityName: "Dee",
      sender: { id: "dee-42", name: "Dee" },
      fromBot: false,
    });
    expect(bot.metadata).toEqual({
      entityName: "Quill",
      sender: { id: "quill-7", name: "Quill" },
      fromBot: true,
    });
  });
});
