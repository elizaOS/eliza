import { describe, expect, it } from "vitest";
import {
  classifyChatFailure,
  getChatFailureReply,
  isChatGenerationTimeoutError,
} from "../chat-routes";

describe("chat failure classification", () => {
  it("detects chat generation timeout errors", () => {
    expect(
      isChatGenerationTimeoutError(
        new Error("Chat generation timed out after 180000ms"),
      ),
    ).toBe(true);
    expect(isChatGenerationTimeoutError(new Error("network error"))).toBe(false);
  });

  it("maps generation timeout to generation_timeout (not provider_issue)", () => {
    const err = new Error("Chat generation timed out after 180000ms");
    expect(classifyChatFailure(err, [])).toBe("generation_timeout");
    expect(getChatFailureReply(err, [])).toMatch(/taking too long/i);
    expect(getChatFailureReply(err, [])).not.toMatch(/provider issue/i);
  });
});
