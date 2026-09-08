/**
 * Regression coverage for the linear-time contract of `extractUserText`. The
 * document-augmentation unwrapper and the language-instruction suffix stripper
 * once placed a greedy whitespace quantifier next to an unbounded body, which
 * backtracked super-linearly (ReDoS-class) on long whitespace runs — a shape
 * pasted logs and transcripts produce on their own, blocking the event loop for
 * seconds. These assertions pin both the output correctness after the regex
 * change and a bounded wall-clock ceiling so the backtracking cannot silently
 * return. The harness is deterministic and real (no mocks).
 */
import { describe, expect, it } from "vitest";
import { getUserMessageText } from "./message-text";

const AUGMENTATION_PREFIX =
	"Answer the user request using the contextual documents";

// A generous ceiling: the fixed patterns complete in well under a millisecond,
// while the former quadratic/cubic behavior took tens of seconds on these
// inputs. 200ms leaves ample slack for slow CI without admitting the ReDoS.
const CEILING_MS = 200;

describe("extractUserText scaling (ReDoS regression)", () => {
	it("does not backtrack on an unclosed <user_request> trailed by a long space run", () => {
		// Cubic-backtracking shape for the former /\s*([\s\S]*?)\s*/ wrapper:
		// an opening tag with no closer, followed by thousands of spaces.
		const raw = `${AUGMENTATION_PREFIX}\n<user_request>${" ".repeat(3000)}`;
		const message = { content: { text: raw } } as never;

		const start = performance.now();
		const result = getUserMessageText(message);
		const elapsed = performance.now() - start;

		// No closing tag means no unwrap; the whole (trimmed) text is returned.
		expect(result).toBe(`${AUGMENTATION_PREFIX}\n<user_request>`);
		expect(elapsed).toBeLessThan(CEILING_MS);
	});

	it("does not backtrack stripping the language suffix off a huge newline run", () => {
		// Quadratic shape for the former leading /\n*/ of the suffix pattern:
		// ~100k newlines walked backwards from every offset.
		const raw = `${"\n".repeat(100_000)}x`;
		const message = { content: { text: raw } } as never;

		const start = performance.now();
		const result = getUserMessageText(message);
		const elapsed = performance.now() - start;

		// The trailing `.trim()` collapses the newline run; only the tail remains.
		expect(result).toBe("x");
		expect(elapsed).toBeLessThan(CEILING_MS);
	});

	it("still strips a real language-instruction suffix after a newline block", () => {
		const raw = `keep this${"\n".repeat(5000)}\n[language instruction: reply in English]`;
		const message = { content: { text: raw } } as never;

		const start = performance.now();
		const result = getUserMessageText(message);
		const elapsed = performance.now() - start;

		expect(result).toBe(`keep this${"\n".repeat(5000)}`.trim());
		expect(result).not.toContain("language instruction");
		expect(elapsed).toBeLessThan(CEILING_MS);
	});

	it("unwraps a well-formed envelope and trims the capture (behavior preserved)", () => {
		const raw = `${AUGMENTATION_PREFIX}\n<user_request>\n  hello world  \n</user_request>`;
		const message = { content: { text: raw } } as never;

		expect(getUserMessageText(message)).toBe("hello world");
	});

	it("keeps the full text for an empty/whitespace-only envelope (guard unchanged)", () => {
		const raw = `${AUGMENTATION_PREFIX}\n<user_request>\n   \n</user_request>`;
		const message = { content: { text: raw } } as never;

		// A whitespace-only capture must remain falsy after trimming, so the
		// original envelope text (trimmed) is returned rather than an empty
		// string — matching the pre-fix `if (match?.[1])` guard behavior.
		expect(getUserMessageText(message)).toBe(raw);
	});
});
