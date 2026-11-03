import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lifeops/feature-flags.js", () => ({
  requireFeatureEnabled: async () => {},
}));

import { runBookTravelHandler } from "./book-travel.js";

const AGENT_ID = "00000000-0000-4000-8000-000000000001" as UUID;
const OWNER_ID = "00000000-0000-4000-8000-000000000002" as UUID;
const ROOM_ID = "00000000-0000-4000-8000-000000000003" as UUID;

const USER_WORDS = "Book a flight to SFO on 2026-06-01.";
const ENVELOPED =
  "Answer the user request using the contextual documents below.\n\n" +
  "Document: a note about a past trip — JFK on 2026-07-04.\n\n" +
  `<user_request>${USER_WORDS}</user_request>`;

const NULL_PLAN = JSON.stringify({
  offerId: null,
  origin: null,
  destination: null,
  departureDate: null,
  returnDate: null,
  passengerCount: null,
  passengers: [],
  calendarSync: null,
});

function makeMessage(text: string): Memory {
  return {
    id: crypto.randomUUID() as UUID,
    entityId: OWNER_ID,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    content: { text, source: "test" },
  } as Memory;
}

function userMessageSection(prompt: string): string {
  const start = prompt.indexOf("User message:\n");
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = prompt.slice(start + "User message:\n".length);
  const end = rest.indexOf("\n\nCurrent parameters:");
  return end >= 0 ? rest.slice(0, end) : rest;
}

async function runWithCapturedPrompt(text: string): Promise<string> {
  let captured = "";
  const runtime = {
    agentId: AGENT_ID,
    useModel: async (_type: unknown, opts: { prompt: string }) => {
      captured = opts.prompt;
      return NULL_PLAN;
    },
  } as unknown as IAgentRuntime;
  const result = await runBookTravelHandler(
    runtime,
    makeMessage(text),
    undefined,
    { parameters: {} },
    async () => {},
  );
  expect(result.data?.error).toBe("MISSING_BOOKING_DETAILS");
  return captured;
}

describe("BOOK_TRAVEL extraction under document augmentation", () => {
  it("sends the plain user words to the extraction model", async () => {
    const prompt = await runWithCapturedPrompt(USER_WORDS);
    expect(userMessageSection(prompt)).toBe(USER_WORDS);
  });

  it("does not let a recalled document supply the trip", async () => {
    const prompt = await runWithCapturedPrompt(ENVELOPED);
    const section = userMessageSection(prompt);
    expect(section).toContain(USER_WORDS);
    expect(section).not.toContain("JFK");
    expect(section).not.toContain("2026-07-04");
    expect(section).not.toContain("contextual documents");
  });
});
