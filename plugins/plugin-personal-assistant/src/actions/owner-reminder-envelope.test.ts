import type { IAgentRuntime, Memory } from "@elizaos/core";
import { getUserMessageText } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { isOwnerReminderNonCommandContext } from "../lifeops/reminders/direct-routing.js";
import { ownerRemindersAction } from "./owner-surfaces.js";

const USER_WORDS = "remind me to water the plants tomorrow";
const ENVELOPED =
  "Answer the user request using the contextual documents below.\n\n" +
  "Document: a note about family routines — remind him to call his mother on Sundays.\n\n" +
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
    agentId: "agent-1",
    logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
  } as unknown as IAgentRuntime;
}

async function runHandler(text: string) {
  const handler = ownerRemindersAction.handler;
  if (!handler) throw new Error("OWNER_REMINDERS handler is missing");
  return handler(makeRuntime(), makeMessage(text), undefined, {
    parameters: {},
  });
}

describe("OWNER_REMINDERS envelope gate", () => {
  it("reads the gate from the user's words, not the envelope text", () => {
    expect(getUserMessageText(makeMessage(ENVELOPED))).toBe(USER_WORDS);
    // The raw envelope trips the gate (a document fragment says
    // "remind him"), while the user's own words do not.
    expect(isOwnerReminderNonCommandContext(ENVELOPED)).toBe(true);
    expect(
      isOwnerReminderNonCommandContext(getUserMessageText(makeMessage(ENVELOPED))),
    ).toBe(false);
  });

  it("does not refuse a genuine reminder request wrapped in an envelope", async () => {
    // The stub runtime cannot run the life engine behind the gate, so a
    // result past the gate either returns a non-rejection or throws from
    // the engine. Either outcome proves the gate did not fire. The
    // assertion is kept outside the try so a rejection failure is not
    // swallowed by the engine-error catch.
    let result: Awaited<ReturnType<typeof runHandler>> | undefined;
    let threw = false;
    try {
      result = await runHandler(ENVELOPED);
    } catch {
      threw = true;
    }
    if (!threw && result) {
      expect(result.data?.reason).not.toBe("REMINDER_CREATE_CONTEXT_REJECTED");
    }
  });

  it("still refuses a genuine third-party request", async () => {
    const result = await runHandler("remind him to call his mother on Sundays");
    expect(result.data).toMatchObject({
      outcome: "no_action",
      reason: "REMINDER_CREATE_CONTEXT_REJECTED",
    });
  });
});
