import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  __resetBriefComposersForTests,
  briefAction,
  setBriefComposers,
} from "./brief.js";

const USER_WORDS = "Give me my morning brief.";
const ENVELOPED =
  "Answer the user request using the contextual documents below.\n\n" +
  "Document: a note about family routines — prep for the board meeting dossier.\n\n" +
  `<user_request>${USER_WORDS}</user_request>`;

function makeMessage(text: string): Memory {
  return {
    entityId: "owner-1",
    roomId: "room-1",
    content: { text },
  } as unknown as Memory;
}

function makeRuntime(): IAgentRuntime {
  return {
    agentId: "owner-1",
    reportError: () => {},
    logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
  } as unknown as IAgentRuntime;
}

async function runHandler(text: string) {
  setBriefComposers({
    loadCalendar: async () => [],
    loadInbox: async () => ({ items: [], coverage: "not_connected" }),
    loadLife: async () => [],
    loadCompletedToday: async () => [],
    loadCommitments: async () => [],
    loadEngagementSummaries: async () => [],
    recordRenderedImpressions: async () => 0,
  });
  const handler = briefAction.handler;
  if (!handler) throw new Error("BRIEF handler is missing");
  try {
    return await handler(makeRuntime(), makeMessage(text), undefined, {
      parameters: {
        subaction: "compose_morning",
        include: {
          calendar: false,
          inbox: false,
          life: false,
          commitments: false,
        },
        format: "json",
      },
    });
  } finally {
    __resetBriefComposersForTests();
  }
}

describe("BRIEF optimization task envelope", () => {
  it("does not let a document fragment flip a plain morning brief to meeting_prep", async () => {
    const result = await runHandler(ENVELOPED);
    expect(result.data?.optimizationTask).toBe("morning_brief");
  });

  it("still selects meeting_prep when the user words ask for it", async () => {
    const result = await runHandler("Brief me on the board meeting.");
    expect(result.data?.optimizationTask).toBe("meeting_prep");
  });

  it("keeps a plain morning brief on morning_brief", async () => {
    const result = await runHandler(USER_WORDS);
    expect(result.data?.optimizationTask).toBe("morning_brief");
  });
});
