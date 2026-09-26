/** Message storage failures must not blame model credentials or unrelated stale billing logs. */
import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  classifyChatFailure,
  getChatFailureReply,
} from "../src/api/chat-routes";

describe("message content failure delivery", () => {
  it.each([
    "MESSAGE_CONTENT_PUBLICATION_CONFLICT",
    "MESSAGE_CONTENT_SEGMENT_STORAGE_UNAVAILABLE",
  ])("classifies %s as a runtime failure", (code) => {
    const error = new ElizaError("private internal diagnostic", { code });
    expect(classifyChatFailure(error, [])).toBe("handler_error");
    expect(getChatFailureReply(error, [])).toBe(
      "I couldn't process the stored message content.",
    );
  });
});
