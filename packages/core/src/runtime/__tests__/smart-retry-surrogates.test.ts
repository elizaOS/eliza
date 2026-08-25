/**
 * Unit tests for surrogate-safe truncation in smart retry context.
 */

import { describe, expect, it } from "vitest";

describe("smart retry surrogate safety", () => {
	it("truncates long validated fields preserving surrogate pairs", () => {
		function truncateUtf16Safe(text: string, maxLength: number): string {
			if (text.length <= maxLength) return text;
			let end = maxLength;
			if (end > 0 && end < text.length) {
				const code = text.charCodeAt(end - 1);
				if (code >= 0xd800 && code <= 0xdbff) {
					end -= 1;
				}
			}
			return text.slice(0, end);
		}

		// "🔥" (2 code units * 260 = 520 units) -> > 500
		// At boundary 497, index 496 is high surrogate of 249th emoji, which bisects without backoff
		const longEmoji = "🔥".repeat(260);
		const truncated =
			longEmoji.length > 500 ? `${truncateUtf16Safe(longEmoji, 497)}...` : longEmoji;

		expect(truncated.endsWith("...")).toBe(true);
		expect(truncated.length).toBe(499); // 496 chars (248 full emojis) + 3 dots

		for (const char of truncated) {
			expect(
				/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
					char,
				),
			).toBe(false);
		}
	});
});
