import { describe, expect, it } from "vitest";
import { shouldReleaseAnonSessionToken } from "./affiliate-claim-session";

describe("shouldReleaseAnonSessionToken", () => {
  it("releases the token after a claim the server finished", () => {
    expect(
      shouldReleaseAnonSessionToken({
        success: true,
        claimed: [{ id: "a" }],
        sessionRetryable: false,
      }),
    ).toBe(true);
  });

  it("keeps the token while a partial claim left the session retryable", () => {
    expect(
      shouldReleaseAnonSessionToken({
        success: true,
        claimed: [{ id: "a" }],
        sessionRetryable: true,
      }),
    ).toBe(false);
  });

  it("keeps the token when nothing was claimed or the sweep failed", () => {
    expect(shouldReleaseAnonSessionToken({ success: true, claimed: [] })).toBe(
      false,
    );
    expect(
      shouldReleaseAnonSessionToken({ success: false, claimed: [{ id: "a" }] }),
    ).toBe(false);
  });
});
