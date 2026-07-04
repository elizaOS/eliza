/**
 * Unit coverage for readAttachmentActionKind — the ATTACHMENT action's routing of
 * the planner-emitted `action`/`subaction` enum (plus dash/space aliases) to read
 * vs save_as_document. Pure-function assertions, no runtime or model.
 */
import { describe, expect, it } from "vitest";
import { readAttachmentActionKind } from "./readAttachmentAction.ts";

/**
 * #10471 — ATTACHMENT action kind must come from the planner-emitted `action`
 * enum, never from English keywords in the user text. The old fallback
 * (`/\bsave\b…\b(document|doc|note|knowledge)\b/i`) silently failed for every
 * non-English request.
 */
describe("readAttachmentActionKind is i18n-safe (#10471)", () => {
	it("routes by the planner action enum (+ aliases)", () => {
		expect(readAttachmentActionKind({ action: "save_as_document" })).toBe(
			"save_as_document",
		);
		expect(readAttachmentActionKind({ action: "save-as-document" })).toBe(
			"save_as_document",
		);
		expect(readAttachmentActionKind({ subaction: "read" })).toBe("read");
	});

	it("defaults to the non-destructive `read`, never inferring from text", () => {
		// No structured action: must be `read` regardless of message text in any
		// language. The old English regex would have returned save_as_document for
		// "save this as a document"; that English-only behavior is gone.
		expect(readAttachmentActionKind({})).toBe("read");
		expect(readAttachmentActionKind({ action: "not-a-real-op" })).toBe("read");
	});
});
