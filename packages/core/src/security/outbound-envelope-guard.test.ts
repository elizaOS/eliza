/**
 * Fail-closed behavior of the outbound envelope guard: envelope material never
 * passes, the replacement notice ships instead, and the block is reported with
 * a clamped preview. Deterministic — pure function over text + a reportError
 * spy.
 */

import { describe, expect, it, vi } from "vitest";
import type { Media } from "../types/primitives.ts";
import { wrapExternalContent } from "./external-content.ts";
import {
	createOutboundEnvelopeStreamLatch,
	ENVELOPE_LEAK_NOTICE,
	guardOutboundEnvelopeAttachments,
	guardOutboundEnvelopeText,
} from "./outbound-envelope-guard.ts";

function makeRuntime() {
	return { reportError: vi.fn() };
}

describe("guardOutboundEnvelopeText", () => {
	it("passes clean text through untouched without reporting", () => {
		const runtime = makeRuntime();
		expect(guardOutboundEnvelopeText(runtime, "deploy is live!", "seam")).toBe(
			"deploy is live!",
		);
		expect(guardOutboundEnvelopeText(runtime, "", "seam")).toBe("");
		expect(runtime.reportError).not.toHaveBeenCalled();
	});

	it("blocks a full leaked envelope and reports with a clamped preview", () => {
		const runtime = makeRuntime();
		const leaked = wrapExternalContent("x".repeat(2000), {
			source: "api",
			includeWarning: true,
		});
		const result = guardOutboundEnvelopeText(
			runtime,
			leaked,
			"visible-callback",
		);
		expect(result).toBe(ENVELOPE_LEAK_NOTICE);
		expect(runtime.reportError).toHaveBeenCalledTimes(1);
		const [scope, error, context] = runtime.reportError.mock.calls[0];
		expect(scope).toBe("outbound-envelope-guard");
		expect(error).toBeInstanceOf(Error);
		expect(context.seam).toBe("visible-callback");
		expect(context.blockedPreview.length).toBeLessThanOrEqual(400);
	});

	it("blocks marker case variants, fullwidth Unicode, quoted and partial echoes", () => {
		const variants = [
			"<<<external_untrusted_content>>>",
			"＜＜＜ＥＸＴＥＲＮＡＬ＿ＵＮＴＲＵＳＴＥＤ＿ＣＯＮＴＥＮＴ＞＞＞",
			'he said "<<<EXTERNAL_UNTRUSTED_CONTENT>>>" earlier',
			'he said "<<<EXTERNAL…"',
			"the <<<END_EXTERNAL_UNTRUSTED_CONTENT>>> marker",
			"SECURITY NOTICE: The following content is from an EXTERNAL, UNTRUSTED source",
		];
		for (const text of variants) {
			const runtime = makeRuntime();
			expect(guardOutboundEnvelopeText(runtime, text, "seam")).toBe(
				ENVELOPE_LEAK_NOTICE,
			);
			expect(runtime.reportError).toHaveBeenCalledTimes(1);
		}
	});

	it("does not block plain nouns colliding with warning words", () => {
		const runtime = makeRuntime();
		expect(
			guardOutboundEnvelopeText(
				runtime,
				'your app "External Content" is deployed',
				"seam",
			),
		).toBe('your app "External Content" is deployed');
		expect(runtime.reportError).not.toHaveBeenCalled();
	});

	it("is idempotent: the notice itself passes the guard", () => {
		const runtime = makeRuntime();
		expect(
			guardOutboundEnvelopeText(runtime, ENVELOPE_LEAK_NOTICE, "seam"),
		).toBe(ENVELOPE_LEAK_NOTICE);
		expect(runtime.reportError).not.toHaveBeenCalled();
	});
});

// Attachment text is a delivery surface of its own: both voice paths ship the
// spoken sentence as attachment.text under an empty top-level text, so the
// text-only guard never sees it.
describe("guardOutboundEnvelopeAttachments", () => {
	function attachment(overrides: Partial<Media>): Media {
		return {
			id: "att-1",
			url: "data:audio/wav;base64,AAAA",
			...overrides,
		} as Media;
	}

	it("returns the same array reference when nothing carries envelope material", () => {
		const runtime = makeRuntime();
		const attachments = [
			attachment({ text: "your site is live!" }),
			attachment({ id: "att-2" }),
		];
		expect(guardOutboundEnvelopeAttachments(runtime, attachments, "seam")).toBe(
			attachments,
		);
		expect(runtime.reportError).not.toHaveBeenCalled();
	});

	it("drops an attachment whose text carries the envelope and reports it", () => {
		const runtime = makeRuntime();
		const leaked = wrapExternalContent("payload", {
			source: "api",
			includeWarning: true,
		});
		const clean = attachment({ id: "att-clean", text: "all good" });
		const result = guardOutboundEnvelopeAttachments(
			runtime,
			[attachment({ text: leaked }), clean],
			"visible-callback-attachment",
		);
		expect(result).toEqual([clean]);
		expect(runtime.reportError).toHaveBeenCalledTimes(1);
		const [scope, error, context] = runtime.reportError.mock.calls[0];
		expect(scope).toBe("outbound-envelope-guard");
		expect(error).toBeInstanceOf(Error);
		expect(context.seam).toBe("visible-callback-attachment");
		expect(context.blockedPreview.length).toBeLessThanOrEqual(400);
	});

	it("drops every leaking attachment, keeping order of the survivors", () => {
		const runtime = makeRuntime();
		const survivors = [
			attachment({ id: "a", text: "first" }),
			attachment({ id: "c", text: "last" }),
		];
		const result = guardOutboundEnvelopeAttachments(
			runtime,
			[
				survivors[0],
				attachment({ id: "b", text: "<<<EXTERNAL_UNTRUSTED_CONTENT>>>" }),
				survivors[1],
			],
			"seam",
		);
		expect(result).toEqual(survivors);
		expect(runtime.reportError).toHaveBeenCalledTimes(1);
	});
});

describe("createOutboundEnvelopeStreamLatch", () => {
	const WARNING_SENTENCE =
		"SECURITY NOTICE: The following content is from an EXTERNAL, UNTRUSTED source";

	it("stays clean while the accumulation is clean, trips when the needle completes, then latches", () => {
		const runtime = makeRuntime();
		const tripped = createOutboundEnvelopeStreamLatch(runtime, "stream-chunk");
		// Prefix of the warning that has not yet completed any needle.
		expect(tripped("SECURITY NOTICE: The following")).toBe(false);
		expect(runtime.reportError).not.toHaveBeenCalled();
		// The accumulation now contains the full warning sentence.
		expect(tripped(`${WARNING_SENTENCE} (e.g., email`)).toBe(true);
		expect(runtime.reportError).toHaveBeenCalledTimes(1);
		const [, , context] = runtime.reportError.mock.calls[0];
		expect(context.seam).toBe("stream-chunk");
		// Latched: every later accumulation stays blocked without re-reporting.
		expect(tripped(`${WARNING_SENTENCE} and more armor`)).toBe(true);
		expect(tripped("harmless tail")).toBe(true);
		expect(runtime.reportError).toHaveBeenCalledTimes(1);
	});

	it("never trips on a clean stream", () => {
		const runtime = makeRuntime();
		const tripped = createOutboundEnvelopeStreamLatch(runtime, "stream-chunk");
		for (const accumulated of [
			"",
			"hey",
			"hey there",
			"hey there, ship's up",
		]) {
			expect(tripped(accumulated)).toBe(false);
		}
		expect(runtime.reportError).not.toHaveBeenCalled();
	});
});
