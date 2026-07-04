/**
 * Unit coverage for `sanitizeConversationMetadata` — a pure, deterministic
 * sanitizer with no runtime or I/O. Pins each allowlist/guard branch of the
 * untrusted-metadata → typed-DTO boundary.
 */
import { describe, expect, it } from "vitest";
import { sanitizeConversationMetadata } from "./conversation-metadata.ts";

/**
 * `sanitizeConversationMetadata` is the untrusted-input → typed-DTO boundary for
 * conversation metadata (#8801 — it shipped untested). It must drop anything not
 * on the scope/automation-type allowlist and coerce every id field through a
 * non-empty-string guard, so a caller can't smuggle an unknown scope or a
 * non-string id into the conversation system. Each branch is pinned here.
 */
describe("sanitizeConversationMetadata", () => {
  it("returns undefined for non-record input", () => {
    for (const v of [null, undefined, "string", 42, true]) {
      expect(sanitizeConversationMetadata(v)).toBeUndefined();
    }
  });

  it("returns undefined when nothing valid survives (empty record)", () => {
    // the sanitizer collapses an all-dropped result to undefined (line 106)
    expect(sanitizeConversationMetadata({})).toBeUndefined();
  });

  it("keeps an allowlisted scope (trimmed) and drops an unknown one", () => {
    expect(sanitizeConversationMetadata({ scope: "  general  " })).toEqual({
      scope: "general",
    });
    expect(sanitizeConversationMetadata({ scope: "page-wallet" })).toEqual({
      scope: "page-wallet",
    });
    expect(
      sanitizeConversationMetadata({ scope: "bogus-scope" }),
    ).toBeUndefined();
  });

  it("keeps an allowlisted automationType and drops an unknown one", () => {
    expect(
      sanitizeConversationMetadata({ automationType: "workflow" }),
    ).toEqual({ automationType: "workflow" });
    expect(
      sanitizeConversationMetadata({ automationType: "not-a-type" }),
    ).toBeUndefined();
  });

  it("keeps non-empty string id fields and drops empty/whitespace/non-string", () => {
    expect(
      sanitizeConversationMetadata({ taskId: "t-1", workflowId: "wf-2" }),
    ).toEqual({ taskId: "t-1", workflowId: "wf-2" });
    // empty, whitespace, and non-string all drop out → nothing survives
    expect(
      sanitizeConversationMetadata({ taskId: "", triggerId: "   ", pageId: 7 }),
    ).toBeUndefined();
  });

  it("passes through a realistic automation payload, ignoring unknown keys", () => {
    expect(
      sanitizeConversationMetadata({
        scope: "automation-workflow",
        automationType: "workflow",
        workflowId: "wf-1",
        workflowName: "Daily report",
        somethingUnknown: "should be ignored",
      }),
    ).toEqual({
      scope: "automation-workflow",
      automationType: "workflow",
      workflowId: "wf-1",
      workflowName: "Daily report",
    });
  });
});
