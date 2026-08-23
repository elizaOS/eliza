import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	containsExternalEnvelopeMaterial: vi.fn(),
}));

vi.mock("./external-content.js", () => ({
	containsExternalEnvelopeMaterial: (...a: unknown[]) =>
		mocks.containsExternalEnvelopeMaterial(...a),
}));

import {
	ENVELOPE_LEAK_NOTICE,
	guardOutboundEnvelopeText,
	reportOutboundEnvelopeBlock,
} from "./outbound-envelope-guard.ts";

describe("guardOutboundEnvelopeText", () => {
	it("passes clean text through untouched", () => {
		mocks.containsExternalEnvelopeMaterial.mockReturnValue(false);
		const runtime = { reportError: vi.fn() };
		expect(guardOutboundEnvelopeText(runtime as never, "hello", "send")).toBe(
			"hello",
		);
		expect(runtime.reportError).not.toHaveBeenCalled();
	});

	it("blocks envelope-bearing text with the notice", () => {
		mocks.containsExternalEnvelopeMaterial.mockReturnValue(true);
		const runtime = { reportError: vi.fn() };
		const out = guardOutboundEnvelopeText(
			runtime as never,
			"<envelope>secret</envelope>",
			"send",
		);
		expect(out).toBe(ENVELOPE_LEAK_NOTICE);
		expect(runtime.reportError).toHaveBeenCalledWith(
			"outbound-envelope-guard",
			expect.any(Error),
			expect.objectContaining({ seam: "send" }),
		);
	});

	it("treats empty text as clean", () => {
		mocks.containsExternalEnvelopeMaterial.mockClear();
		const runtime = { reportError: vi.fn() };
		expect(guardOutboundEnvelopeText(runtime as never, "", "send")).toBe("");
		expect(mocks.containsExternalEnvelopeMaterial).not.toHaveBeenCalled();
	});
});

describe("reportOutboundEnvelopeBlock", () => {
	it("reports a bounded preview without re-broadcasting the full text", () => {
		const runtime = { reportError: vi.fn() };
		const long = "x".repeat(1000);
		reportOutboundEnvelopeBlock(runtime as never, long, "pipeline");
		const args = runtime.reportError.mock.calls[0];
		expect(args[0]).toBe("outbound-envelope-guard");
		expect(args[2].seam).toBe("pipeline");
		expect(args[2].blockedPreview.length).toBeLessThanOrEqual(400);
	});
});
