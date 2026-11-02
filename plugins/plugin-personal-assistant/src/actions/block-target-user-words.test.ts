import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { blockAction } from "./block.js";

const USER_WORDS = "Block the website for 2 hours.";
const ENVELOPED =
  "Answer the user request using the contextual documents below.\n\n" +
  "Document: a note about family routines — block apps on my phone for focus.\n\n" +
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
    reportError: () => {},
    logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
  } as unknown as IAgentRuntime;
}

async function runHandler(text: string) {
  const handler = blockAction.handler;
  if (!handler) throw new Error("BLOCK handler is missing");
  return handler(makeRuntime(), makeMessage(text), undefined, undefined);
}

describe("BLOCK target envelope", () => {
  it("routes a plain website request to the website backend", async () => {
    const result = await runHandler(USER_WORDS);
    expect(result.text).toContain("Website blocking");
  });

  it("does not let a document fragment flip a website request to the app backend", async () => {
    const result = await runHandler(ENVELOPED);
    expect(result.text).toContain("Website blocking");
    expect(result.text).not.toContain("App blocking");
  });
});
