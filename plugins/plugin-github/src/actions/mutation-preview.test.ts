/** Verifies complete well-formed GitHub mutation confirmation bodies. */

import { describe, expect, it } from "vitest";
import { buildPreview } from "./issue-op.js";
import { buildReviewPreview, parseReviewAction } from "./pr-op.js";

describe("GitHub mutation previews", () => {
  it("shows the complete issue comment body", () => {
    const body = `${"i".repeat(180)} issue-tail`;
    expect(
      buildPreview("comment", "elizaOS/eliza", "owner", {
        number: 42,
        body,
      }),
    ).toContain(body);
  });

  it("shows the complete PR body and repairs malformed Unicode", () => {
    const body = `${"p".repeat(180)} ${String.fromCharCode(0xd800)} pr-tail`;
    const preview = buildReviewPreview(
      "request-changes",
      "elizaOS/eliza",
      42,
      body,
      "owner",
    );
    expect(preview.isWellFormed()).toBe(true);
    expect(preview).toContain("pr-tail");
  });

  it("normalizes review action casing, underscores, and whitespace", () => {
    expect(parseReviewAction("approve")).toBe("approve");
    expect(parseReviewAction("APPROVE")).toBe("approve");
    expect(parseReviewAction("request_changes")).toBe("request-changes");
    expect(parseReviewAction("REQUEST_CHANGES")).toBe("request-changes");
    expect(parseReviewAction("  comment  ")).toBe("comment");
    expect(parseReviewAction("invalid_action")).toBeNull();
    expect(parseReviewAction(null)).toBeNull();
    expect(parseReviewAction(123)).toBeNull();
  });
});
