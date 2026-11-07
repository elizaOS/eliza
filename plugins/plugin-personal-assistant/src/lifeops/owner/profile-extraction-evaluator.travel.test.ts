/**
 * A travel record that a booking or the owner's device opened carries the
 * destination time zone and the real dates. An everyday sentence that the
 * travel patterns match must not replace or clear it; the sentence path
 * still manages the records it opened itself.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { expect, it } from "vitest";
import { createOwnerFactStore } from "./fact-store.ts";
import { ownerProfileExtractionEvaluator } from "./profile-extraction-evaluator.ts";

function runtimeWithCache(): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    getCache: async (key: string) => cache.get(key),
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    },
    deleteCache: async (key: string) => cache.delete(key),
    getService: () => null,
  } as unknown as IAgentRuntime;
}

const booked = {
  startIso: "2026-11-01T00:00:00.000Z",
  endIso: "2026-11-10T00:00:00.000Z",
  destinationTimezone: "Asia/Tokyo",
};

async function ownerSays(runtime: IAgentRuntime, text: string) {
  await ownerProfileExtractionEvaluator.evaluate({
    runtime,
    message: {
      id: "00000000-0000-4000-8000-000000000101",
      entityId: "00000000-0000-4000-8000-000000000102",
      roomId: "00000000-0000-4000-8000-000000000103",
      content: { text },
    } as Memory,
  } as never);
  return (await createOwnerFactStore(runtime).read()).activeTravel;
}

it("keeps a booked travel record when the owner says they are away from their desk", async () => {
  const runtime = runtimeWithCache();
  await createOwnerFactStore(runtime).setActiveTravel(booked, {
    source: "connector_inferred",
    recordedAt: "2026-11-01T00:00:00.000Z",
  });
  const after = await ownerSays(runtime, "I'm away from my desk for an hour.");
  expect(after?.value).toEqual(booked);
});

it("keeps a booked travel record when the owner says they got back from dinner", async () => {
  const runtime = runtimeWithCache();
  await createOwnerFactStore(runtime).setActiveTravel(booked, {
    source: "connector_inferred",
    recordedAt: "2026-11-01T00:00:00.000Z",
  });
  const after = await ownerSays(
    runtime,
    "Got back from dinner, what did I miss?",
  );
  expect(after?.value).toEqual(booked);
});

it("still opens and clears the records the sentence path owns", async () => {
  const runtime = runtimeWithCache();
  const opened = await ownerSays(runtime, "I'm traveling until next Friday.");
  const cleared = await ownerSays(runtime, "I'm back home.");
  expect({ opened: opened?.provenance.source, cleared }).toEqual({
    opened: "agent_inferred",
    cleared: undefined,
  });
});
