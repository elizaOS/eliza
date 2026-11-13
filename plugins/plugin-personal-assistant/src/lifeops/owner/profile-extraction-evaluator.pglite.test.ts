/**
 * Real-PGlite proof that the timezone the plugin's `owner.profile_extraction`
 * evaluator stores from an owner message stays usable as the shared calendar
 * zone (plugin init registers the owner fact as the calendar zone resolver):
 * the period that ends the sentence is not part of the zone, an alias is
 * stored as its IANA zone, and a statement naming no zone leaves the stored
 * zone in place.
 */

import { resolveCalendarTimeZone } from "@elizaos/contracts";
import {
  type AgentRuntime,
  type Memory,
  type MessageHandlerResult,
  runResponseHandlerEvaluators,
  type UUID,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.js";

let runtimeResult: RealTestRuntimeResult | null = null;
let runtime: AgentRuntime;

async function ownerSays(text: string): Promise<void> {
  const message = {
    id: crypto.randomUUID() as UUID,
    agentId: runtime.agentId,
    entityId: runtime.agentId,
    roomId: crypto.randomUUID() as UUID,
    content: { source: "autonomy", text },
  } as Memory;
  const messageHandler: MessageHandlerResult = {
    processMessage: "RESPOND",
    plan: { contexts: [] },
    thought: "",
  };
  const result = await runResponseHandlerEvaluators({
    runtime,
    message,
    state: { text: "", values: {}, data: {} },
    messageHandler,
    availableContexts: [],
  });
  expect(
    result.errors.filter(
      (error) => error.evaluatorName === "owner.profile_extraction",
    ),
  ).toEqual([]);
}

beforeAll(async () => {
  runtimeResult = await createLifeOpsTestRuntime();
  runtime = runtimeResult.runtime;
}, 180_000);

afterAll(async () => {
  await runtimeResult?.cleanup();
});

describe("owner.profile_extraction timezone and the calendar zone", () => {
  it("resolves the calendar zone after the owner states it in a sentence", async () => {
    await ownerSays("My timezone is America/New_York.");

    await expect(resolveCalendarTimeZone(runtime, new Date())).resolves.toEqual(
      { timeZone: "America/New_York", source: "owner" },
    );
  });

  it("stores the IANA zone for an alias the shared resolver knows", async () => {
    await ownerSays("my timezone is pacific.");

    await expect(resolveCalendarTimeZone(runtime, new Date())).resolves.toEqual(
      { timeZone: "America/Los_Angeles", source: "owner" },
    );
  });

  it("keeps the stored zone when the owner names no zone", async () => {
    await ownerSays("My timezone is Europe/Berlin");
    await ownerSays("my timezone is whatever the laptop says.");

    await expect(resolveCalendarTimeZone(runtime, new Date())).resolves.toEqual(
      { timeZone: "Europe/Berlin", source: "owner" },
    );
  });
});
