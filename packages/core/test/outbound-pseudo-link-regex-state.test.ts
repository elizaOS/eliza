/**
 * `sanitizeOutboundText` is the text-delivery boundary that degrades
 * model-invented `[LINK:<url>]` markers to ordinary Markdown. Its cheap
 * pre-filter tests the same marker regex before deciding whether the whole
 * pipeline runs, so no scan may leave a `lastIndex` behind for the next
 * message: an unterminated `[LINK:<url>` (no closing `]`) breaks out of the
 * scan mid-text, and the message after it was then returned with its raw
 * marker syntax intact.
 */

import { describe, expect, it } from "vitest";
import { sanitizeOutboundText } from "../src/security/outbound-sanitize.ts";

describe("sanitizeOutboundText pseudo-link scan state", () => {
	it("degrades a pseudo-link after an unterminated marker", () => {
		// Message 1: model drift, the marker is never closed — nothing to rewrite.
		expect(sanitizeOutboundText("[LINK:https://x.example")).toBe(
			"[LINK:https://x.example",
		);
		// Message 2: unrelated and well-formed — degraded, not passed through raw.
		expect(
			sanitizeOutboundText("[LINK:https://good.example/page](Read more)"),
		).toBe("[Read more](https://good.example/page)");
		expect(sanitizeOutboundText("[LINK:https://bare.example]")).toBe(
			"https://bare.example",
		);
	});

	it("degrades every marker shape", () => {
		expect(
			sanitizeOutboundText(
				"[LINK:https://a.example/x][LINK:https://b.example/y]",
			),
		).toBe("https://a.example/xhttps://b.example/y");
		expect(sanitizeOutboundText("[link:https://up.example/z](Up)")).toBe(
			"[Up](https://up.example/z)",
		);
		expect(
			sanitizeOutboundText("see [LINK:https://mid.example](Mid) now"),
		).toBe("see [Mid](https://mid.example) now");
	});

	it("leaves malformed markers and code spans alone", () => {
		expect(sanitizeOutboundText("[LINK:ftp://nope.example](x)")).toBe(
			"[LINK:ftp://nope.example](x)",
		);
		expect(sanitizeOutboundText("`[LINK:https://code.example](x)`")).toBe(
			"`[LINK:https://code.example](x)`",
		);
	});
});
