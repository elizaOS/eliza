/**
 * Tests for the one-off relationship follow-up reminder narrowing in the
 * ACTIONS provider. A message such as "remind me to follow up with Dana
 * tomorrow" keeps REPLY/IGNORE/NONE and follow-up-capable actions visible and
 * drops the rest of the catalog; a recurring cadence ("every Friday") keeps
 * the whole catalog.
 *
 * Deterministic: real AgentRuntime + SQLiteDatabaseAdapter; no model calls.
 */

import type { Action, Memory, State, UUID } from "@elizaos/core";
import {
  AgentRuntime,
  createCharacter,
  FOLLOW_UP_CAPABLE_ACTION_TAG,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { actionsProvider } from "./actions.ts";

const ROOM_ID = "66666666-6666-6666-6666-666666666661" as UUID;
const USER_ID = "66666666-6666-6666-6666-666666666662" as UUID;
const MESSAGE_ID = "66666666-6666-6666-6666-666666666663" as UUID;

const runtimes: AgentRuntime[] = [];

afterEach(async () => {
  while (runtimes.length > 0) {
    await runtimes.pop()?.stop();
  }
});

async function createRuntime(): Promise<AgentRuntime> {
  const runtime = new AgentRuntime({
    character: createCharacter({ name: "Eliza" }),
    logLevel: "fatal",
    enableAutonomy: false,
  });
  runtime.registerDatabaseAdapter(
    SQLiteDatabaseAdapter.create(":memory:", runtime.agentId),
  );
  await runtime.initialize();
  runtimes.push(runtime);
  const followUpAction: Action = {
    name: "TEST_FOLLOW_UP",
    description: "Schedule a follow-up with a contact.",
    contexts: ["general"],
    tags: [FOLLOW_UP_CAPABLE_ACTION_TAG],
    validate: async () => true,
    handler: async () => ({ success: true }),
  };
  const unrelatedAction: Action = {
    name: "TEST_UNRELATED",
    description: "An action unrelated to follow-ups.",
    contexts: ["general"],
    validate: async () => true,
    handler: async () => ({ success: true }),
  };
  runtime.registerAction(followUpAction);
  runtime.registerAction(unrelatedAction);
  return runtime;
}

async function visibleActionNames(
  runtime: AgentRuntime,
  text: string,
): Promise<string[]> {
  const message = {
    id: MESSAGE_ID,
    entityId: USER_ID,
    roomId: ROOM_ID,
    content: { text, source: "test" },
  } as Memory;
  const state = { values: {}, data: {}, text: "" } as State;
  const result = await actionsProvider.get(runtime, message, state);
  const actionsData = (result.data?.actionsData ?? []) as Action[];
  return actionsData.map((action) => action.name);
}

describe("ACTIONS provider relationship follow-up reminder narrowing", () => {
  for (const text of [
    "Remind me to follow up with Dana tomorrow",
    "Remind me to follow up with Dana at 3 pm",
    "Remind me to follow up with Dana at 3pm",
    "Remind me to follow up with Dana at 10am",
    "Remind me to follow up with Dana at 10:30",
    "Remind me to follow up with Dana at 11",
  ]) {
    it(`narrows the catalog for "${text}"`, async () => {
      const runtime = await createRuntime();
      const names = await visibleActionNames(runtime, text);
      expect(names).toContain("TEST_FOLLOW_UP");
      expect(names).not.toContain("TEST_UNRELATED");
    });
  }

  it("keeps the whole catalog for a recurring follow-up", async () => {
    const runtime = await createRuntime();
    const names = await visibleActionNames(
      runtime,
      "Remind me to follow up with Dana every Friday at 3pm",
    );
    expect(names).toContain("TEST_FOLLOW_UP");
    expect(names).toContain("TEST_UNRELATED");
  });
});
