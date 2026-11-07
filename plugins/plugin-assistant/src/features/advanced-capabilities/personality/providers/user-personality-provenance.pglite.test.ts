/**
 * Real-PGlite coverage for the provider's provenance note: after the
 * preference extractor and explicit PERSONALITY writes share a slot, the note
 * must follow each directive's recorded writer, not the slot's last writer.
 */
import {
  ChannelType,
  type Memory,
  type State,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { preferenceEvaluator } from "../../evaluators/preference-items.ts";
import { PersonalityStore } from "../services/personality-store.ts";
import { PersonalityServiceType } from "../types.ts";
import { userPersonalityProvider } from "./user-personality.ts";

const STATE: State = { values: {}, data: {}, text: "" };
const ROOM = stringToUuid("user-personality-provenance-room");

let fixture: Awaited<ReturnType<typeof createTestRuntime>>;

beforeAll(async () => {
  fixture = await createTestRuntime();
  await fixture.runtime.registerService(PersonalityStore);
  await fixture.runtime.getServiceLoadPromise(
    PersonalityServiceType.PERSONALITY_STORE,
  );
  await fixture.runtime.createRooms([
    {
      id: ROOM,
      agentId: fixture.runtime.agentId,
      source: "test",
      type: ChannelType.DM,
    },
  ]);
}, 180_000);

afterAll(async () => {
  await fixture?.cleanup();
});

function store(): PersonalityStore {
  return fixture.runtime.getService<PersonalityStore>(
    PersonalityServiceType.PERSONALITY_STORE,
  ) as PersonalityStore;
}

async function newUser(name: string): Promise<UUID> {
  const id = stringToUuid(`user-personality-provenance-${name}`);
  await fixture.runtime.createEntities([
    { id, agentId: fixture.runtime.agentId, names: [name] },
  ]);
  return id;
}

function turn(userId: UUID, text: string): Memory {
  return {
    id: stringToUuid(`user-personality-provenance-${userId}-${text}`),
    entityId: userId,
    agentId: fixture.runtime.agentId,
    roomId: ROOM,
    content: { text, source: "test" },
    createdAt: Date.now(),
  };
}

/** Runs the extractor's own processor with the given model output. */
async function applyPreferenceOps(message: Memory, ops: unknown[]) {
  const runtime = fixture.runtime;
  const options = {};
  const prepared = await preferenceEvaluator.prepare?.({
    runtime,
    message,
    state: STATE,
    options,
  } as never);
  return preferenceEvaluator.processors?.[0].process({
    runtime,
    message,
    state: STATE,
    options,
    prepared,
    output: { ops },
    evaluatorName: preferenceEvaluator.name,
  } as never);
}

describe("userPersonalityProvider provenance", () => {
  it("does not label a user-set trait as inferred after the extractor retracts its own directive", async () => {
    const runtime = fixture.runtime;
    const userId = await newUser("retracted");
    // PERSONALITY set_trait writes with the default "user" source.
    await store().applyTrait({
      scope: "user",
      userId,
      agentId: runtime.agentId,
      actorId: userId,
      trait: "verbosity",
      value: "terse",
    });
    const added = await applyPreferenceOps(turn(userId, "no emojis please"), [
      {
        op: "add_directive",
        scope: "across_conversations",
        text: "No emojis",
        confidence: 0.9,
      },
    ]);
    expect(added?.values).toMatchObject({ directivesAdded: 1 });
    const retracted = await applyPreferenceOps(
      turn(userId, "actually emojis are fine"),
      [
        {
          op: "retract_directive",
          scope: "across_conversations",
          text: "No emojis",
          confidence: 0.9,
        },
      ],
    );
    expect(retracted?.values).toMatchObject({ directivesRetracted: 1 });
    expect(store().getSlot(userId)).toMatchObject({
      verbosity: "terse",
      trait_sources: { verbosity: "user" },
      custom_directives: [],
    });

    const result = await userPersonalityProvider.get(
      runtime,
      turn(userId, "hi"),
      STATE,
    );

    expect(result.text).toBe(
      [
        "[PERSONALITY for THIS user]",
        "- verbosity: terse",
        "[/PERSONALITY for THIS user]",
      ].join("\n"),
    );
  });

  it("does not label a user-set trait as inferred after the extractor retracts its own trait", async () => {
    const runtime = fixture.runtime;
    const userId = await newUser("trait-retracted");
    await store().applyTrait({
      scope: "user",
      userId,
      agentId: runtime.agentId,
      actorId: userId,
      trait: "verbosity",
      value: "terse",
    });
    const set = await applyPreferenceOps(turn(userId, "be warmer"), [
      {
        op: "set_trait",
        scope: "across_conversations",
        trait: "tone",
        value: "warm",
        confidence: 0.9,
      },
    ]);
    expect(set?.values).toMatchObject({ traitsSet: 1 });
    const retracted = await applyPreferenceOps(
      turn(userId, "no, your normal tone is fine"),
      [{ op: "retract_trait", scope: "across_conversations", trait: "tone" }],
    );
    expect(retracted?.values).toMatchObject({ traitsRetracted: 1 });
    expect(store().getSlot(userId)).toMatchObject({
      verbosity: "terse",
      tone: null,
      trait_sources: { verbosity: "user" },
      custom_directives: [],
    });

    const result = await userPersonalityProvider.get(
      runtime,
      turn(userId, "hi"),
      STATE,
    );

    expect(result.text).toBe(
      [
        "[PERSONALITY for THIS user]",
        "- verbosity: terse",
        "[/PERSONALITY for THIS user]",
      ].join("\n"),
    );
  });

  it("keeps the note for an inferred directive after the user adds their own", async () => {
    const runtime = fixture.runtime;
    const userId = await newUser("mixed");
    const added = await applyPreferenceOps(
      turn(userId, "ugh, stop with the emojis"),
      [
        {
          op: "add_directive",
          scope: "across_conversations",
          text: "No emojis",
          confidence: 0.9,
        },
      ],
    );
    expect(added?.values).toMatchObject({ directivesAdded: 1 });
    // PERSONALITY add_directive writes with the default "user" source.
    await store().addDirective({
      userId,
      agentId: runtime.agentId,
      actorId: userId,
      directive: "Use bullet points",
    });
    expect(store().getSlot(userId).directive_sources).toEqual({
      "No emojis": "agent_inferred",
      "Use bullet points": "user",
    });

    const result = await userPersonalityProvider.get(
      runtime,
      turn(userId, "hi"),
      STATE,
    );

    expect(result.text).toContain("  1. No emojis");
    expect(result.text).toContain(
      "- provenance: some of these inferred from conversation, not explicitly set; offer to adjust if the user objects",
    );
  });
});
