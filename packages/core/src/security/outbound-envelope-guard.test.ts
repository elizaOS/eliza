/**
 * Fail-closed behavior of the outbound envelope guard: envelope material never
 * passes, the replacement notice ships instead, and the block is reported with
 * a clamped preview. Deterministic — pure function over text + a reportError
 * spy.
 */

import { describe, expect, it, vi } from "vitest";
import { wrapExternalContent } from "./external-content.ts";
import {
	ENVELOPE_LEAK_NOTICE,
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
