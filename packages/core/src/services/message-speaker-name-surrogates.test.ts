/**
 * Unit tests for surrogate-pair safe speaker name truncation in message services.
 *
 * Verifies that cleanPriorDialogueSpeakerName keeps UTF-16 surrogate pairs intact
 * when truncating long speaker/entity names to 80 characters with trailing ellipsis.
 */

import { describe, expect, it } from "vitest";
import { cleanPriorDialogueSpeakerName } from "./message.ts";

describe("cleanPriorDialogueSpeakerName surrogate safety", () => {
	it("returns undefined for non-strings or empty strings", () => {
		expect(cleanPriorDialogueSpeakerName(null)).toBeUndefined();
		expect(cleanPriorDialogueSpeakerName(undefined)).toBeUndefined();
		expect(cleanPriorDialogueSpeakerName(123)).toBeUndefined();
		expect(cleanPriorDialogueSpeakerName("   ")).toBeUndefined();
	});

	it("returns short names unchanged", () => {
		expect(cleanPriorDialogueSpeakerName("Alice")).toBe("Alice");
		expect(cleanPriorDialogueSpeakerName("  Bob  Smith  ")).toBe("Bob Smith");
	});

	it("preserves surrogate pairs when truncating at 80 characters", () => {
		// "🔥" (2 chars * 45 = 90 chars) -> 90 chars > 80 chars
		// At boundary 77, index 76 is high surrogate of 39th emoji, which bisects without backoff
		const longEmojiName = "🔥".repeat(45);
		const cleaned = cleanPriorDialogueSpeakerName(longEmojiName);
		expect(cleaned).toBeDefined();
		expect(cleaned?.endsWith("...")).toBe(true);
		expect(cleaned?.length).toBe(79); // 76 chars (38 full emojis) + 3 dots

		for (const char of cleaned!) {
			expect(
				/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
					char,
				),
			).toBe(false);
		}
	});
});
