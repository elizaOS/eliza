import type { Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";

import { isExplicitLifeDraftConfirmation } from "./scheduled-task";

function message(text: string): Memory {
  return {
    entityId: "owner-1",
    roomId: "room-1",
    content: { text },
  } as unknown as Memory;
}

describe("SCHEDULED_TASKS life-draft confirmation reads user words", () => {
  it("does not confirm a draft from an approval word inside contextual documents", () => {
    const augmented =
      "Answer the user request using the contextual documents\n" +
      "<contextual_documents>Budget approved for Q4.</contextual_documents>\n" +
      "<user_request>Show me the draft.</user_request>";
    expect(isExplicitLifeDraftConfirmation(message(augmented))).toBe(false);
  });

  it("does not let a negation word inside documents veto a genuine confirmation", () => {
    const augmented =
      "Answer the user request using the contextual documents\n" +
      "<contextual_documents>Cancel the old plan first.</contextual_documents>\n" +
      "<user_request>Yes, save it.</user_request>";
    expect(isExplicitLifeDraftConfirmation(message(augmented))).toBe(true);
  });

  it("still recognises a genuine confirmation wrapped in the envelope", () => {
    const augmented =
      "Answer the user request using the contextual documents\n" +
      "<contextual_documents>Budget approved for Q4.</contextual_documents>\n" +
      "<user_request>Yes, confirm it.</user_request>";
    expect(isExplicitLifeDraftConfirmation(message(augmented))).toBe(true);
  });

  it("still recognises a plain confirmation", () => {
    expect(isExplicitLifeDraftConfirmation(message("Yes, save it."))).toBe(
      true,
    );
  });

  it("still rejects a plain non-confirming ask", () => {
    expect(isExplicitLifeDraftConfirmation(message("Show me the draft."))).toBe(
      false,
    );
  });

  it("still rejects a plain negation", () => {
    expect(isExplicitLifeDraftConfirmation(message("Not yet, hold off."))).toBe(
      false,
    );
  });
});
