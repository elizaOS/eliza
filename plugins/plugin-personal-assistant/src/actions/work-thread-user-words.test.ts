/**
 * WORK_THREAD validate must read the user's words, not the envelope.
 *
 * validate() offers the action when the message looks like thread lifecycle
 * intent. It scanned the raw rendered text, so under document augmentation
 * a recalled document containing a lifecycle phrase ("mark this done")
 * made validate return true even when the user's own request had no
 * lifecycle intent and no thread was active in the room. The same applies
 * to a connector envelope prefixing the user's words. After the fix, the
 * gate reads getUserMessageText, which prefers currentMessageText and
 * strips the document-augmentation wrapper.
 *
 * The runtime stub is the agent itself (entityId === agentId), so the
 * owner-access check passes via the agent-self shortcut and the
 * lifecycle-intent branch decides the outcome; when it does not fire,
 * the active-thread lookup has no store behind the stub and fails closed
 * to false, which is exactly the contrast these cases need.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { workThreadAction } from "./work-thread.ts";

const AGENT_ID = "agent-1";

function makeRuntime() {
  return {
    agentId: AGENT_ID,
    reportError: () => {},
  } as unknown as IAgentRuntime;
}

function makeMessage(content: Record<string, unknown>): Memory {
  return {
    entityId: AGENT_ID,
    roomId: "room-1",
    content,
  } as unknown as Memory;
}

const AUGMENTED_TEXT = [
  "Answer the user request using the contextual documents below as the source of truth when they contain the answer.",
  "If the answer appears verbatim in the contextual documents, repeat it exactly.",
  "",
  "<contextual_documents>",
  '<source title="office notes" similarity="0.900">',
  "The team agreed to mark this done on Friday.",
  "</source>",
  "</contextual_documents>",
  "",
  "<user_request>",
  "show me my schedule summary",
  "</user_request>",
].join("\n");

async function validateFor(content: Record<string, unknown>) {
  const validate = workThreadAction.validate;
  expect(validate).toBeTypeOf("function");
  return validate!(makeRuntime(), makeMessage(content), undefined as never);
}

describe("work-thread validate user words", () => {
  it("does not offer the action when only a recalled document has lifecycle intent", async () => {
    await expect(
      validateFor({ text: AUGMENTED_TEXT }),
    ).resolves.toBe(false);
  });

  it("does not offer the action when only a connector envelope carries lifecycle intent", async () => {
    await expect(
      validateFor({
        text: "[Discord #general] @someone (2026-11-02 09:00): mark this done",
        currentMessageText: "show me my schedule summary",
      }),
    ).resolves.toBe(false);
  });

  it("still offers the action for a plain lifecycle request", async () => {
    await expect(validateFor({ text: "mark this done" })).resolves.toBe(
      true,
    );
  });

  it("keeps a plain non-lifecycle request unoffered", async () => {
    await expect(
      validateFor({ text: "show me my schedule summary" }),
    ).resolves.toBe(false);
  });
});
