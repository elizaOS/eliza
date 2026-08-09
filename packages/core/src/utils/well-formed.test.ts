/**
 * Deterministic unit coverage for the well-formed Unicode helpers: truncation
 * must never split a surrogate pair (the #18025 failure mode — a mid-emoji
 * slice produced a lone leading surrogate that Cerebras's strict JSON parser
 * rejected with `wrong_api_format`), and the sanitizers must turn any lone
 * surrogate into U+FFFD so a serialized request body never carries a bare
 * \uD8xx escape.
 */

import { describe, expect, it } from "vitest";
import {
	deepToWellFormedUnicode,
	tailWellFormed,
	toWellFormedUnicode,
	truncateWellFormed,
} from "./well-formed";

/** JSON.stringify escapes ONLY lone surrogates as \ud8xx..\udfff; well-formed
 * astral characters are emitted raw. A strict parser (serde_json, Cerebras)
 * rejects those escapes, so their absence is the wire-safety invariant. */
const LONE_SURROGATE_ESCAPE = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/;

function isWellFormed(text: string): boolean {
	return (text as unknown as { isWellFormed: () => boolean }).isWellFormed();
}

describe("truncateWellFormed", () => {
	it("backs the boundary off by one when the cut lands mid-emoji", () => {
		const text = "abc💀def"; // 💀 = 💀 at index 3..4
		const cut = truncateWellFormed(text, 4);
		expect(cut).toBe("abc");
		expect(isWellFormed(cut)).toBe(true);
	});

	it("keeps a complete emoji that fits exactly", () => {
		expect(truncateWellFormed("abc💀def", 5)).toBe("abc💀");
	});

	it("produces well-formed output at every possible boundary", () => {
		const text = "hi 👩‍👩‍👧‍👦 mixed 🇺🇸 text 💀🔥 end";
		for (let n = 0; n <= text.length + 1; n++) {
			const cut = truncateWellFormed(text, n);
			expect(isWellFormed(cut)).toBe(true);
			expect(cut.length).toBeLessThanOrEqual(Math.max(0, n));
			expect(text.startsWith(cut)).toBe(true);
		}
	});

	it("returns short input unchanged (same reference)", () => {
		const text = "short 💀";
		expect(truncateWellFormed(text, 100)).toBe(text);
	});

	it("returns empty string for non-positive budgets", () => {
		expect(truncateWellFormed("abc", 0)).toBe("");
		expect(truncateWellFormed("abc", -1)).toBe("");
	});

	it("preserves a pre-existing lone surrogate (sanitizing is not its job)", () => {
		const malformed = `x\uD83D`;
		expect(truncateWellFormed(`${malformed}yz`, 2)).toBe(malformed);
	});
});

describe("tailWellFormed", () => {
	it("advances past a split pair so the tail never starts on a low surrogate", () => {
		const text = "abc💀def"; // low half \uDC80 at index 4
		const tail = tailWellFormed(text, 4);
		expect(tail).toBe("def");
		expect(isWellFormed(tail)).toBe(true);
	});

	it("produces well-formed output at every possible boundary", () => {
		const text = "hi 👩‍👩‍👧‍👦 mixed 🇺🇸 text 💀🔥 end";
		for (let n = 0; n <= text.length + 1; n++) {
			const tail = tailWellFormed(text, n);
			expect(isWellFormed(tail)).toBe(true);
			expect(text.endsWith(tail)).toBe(true);
		}
	});

	it("returns short input unchanged and empty for non-positive budgets", () => {
		expect(tailWellFormed("💀", 5)).toBe("💀");
		expect(tailWellFormed("abc", 0)).toBe("");
	});
});

describe("toWellFormedUnicode", () => {
	it("replaces lone leading (high) surrogates with U+FFFD", () => {
		expect(toWellFormedUnicode("bad \uD83D end")).toBe("bad � end");
	});

	it("replaces lone trailing (low) surrogates with U+FFFD", () => {
		expect(toWellFormedUnicode("bad \uDC80 end")).toBe("bad � end");
	});

	it("preserves valid pairs, including adjacent emoji and ZWJ sequences", () => {
		const text = "ok 💀🔥 👩‍👩‍👧‍👦 🇺🇸";
		expect(toWellFormedUnicode(text)).toBe(text);
	});

	it("handles a trailing lone high surrogate (the mid-emoji slice shape)", () => {
		expect(toWellFormedUnicode("truncated 💀".slice(0, 11))).toBe(
			"truncated �",
		);
	});
});

describe("deepToWellFormedUnicode", () => {
	it("sanitizes strings nested in arrays and plain objects", () => {
		const input = {
			messages: [
				{ role: "tool", content: [{ type: "text", text: `oops \uD83D` }] },
			],
		};
		const output = deepToWellFormedUnicode(input);
		expect(output.messages[0].content[0].text).toBe("oops �");
	});

	it("returns the same reference when nothing needs sanitizing", () => {
		const input = { a: ["clean 💀", { b: "fine" }] };
		expect(deepToWellFormedUnicode(input)).toBe(input);
	});

	it("passes non-plain objects through untouched", () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const input = { data: bytes, url: new URL("https://example.com/") };
		const output = deepToWellFormedUnicode(input);
		expect(output.data).toBe(bytes);
		expect(output.url).toBe(input.url);
	});

	it("preserves null, numbers, and booleans", () => {
		const input = { a: null, b: 42, c: true, d: undefined };
		expect(deepToWellFormedUnicode(input)).toBe(input);
	});

	// #18081: JSON object keys containing lone surrogates must be sanitized.
	it("sanitizes object keys containing lone surrogates (#18081)", () => {
		const input = { "bad\uD83D": "ok" };
		const output = deepToWellFormedUnicode(input);
		const serialized = JSON.stringify(output);
		expect(LONE_SURROGATE_ESCAPE.test(serialized)).toBe(false);
		// The sanitized key should be "bad�"
		expect(Object.keys(output)).toEqual(["bad�"]);
	});

	// #18081: An own __proto__ key from a JSON-parsed input must be preserved
	// as a data member, not collapsed into the clone's prototype chain.
	it("preserves own __proto__ key as a data member (#18081)", () => {
		const input = JSON.parse('{"__proto__":{"marker":"kept"},"bad":"clean"}');
		const output = deepToWellFormedUnicode(input);
		// The own __proto__ key must survive as an enumerable own property.
		const desc = Object.getOwnPropertyDescriptor(output, "__proto__");
		expect(desc).toBeDefined();
		expect(desc?.enumerable).toBe(true);
		expect((desc?.value as { marker: string } | undefined)?.marker).toBe(
			"kept",
		);
		// JSON round-trip must contain __proto__ as a data key.
		const serialized = JSON.stringify(output);
		expect(serialized).toContain('"__proto__"');
		expect(serialized).toContain('"marker":"kept"');
	});

	it("preserves own __proto__ key with a lone surrogate in a sibling value (#18081)", () => {
		const input = JSON.parse('{"__proto__":{"marker":"kept"},"bad":"\\uD83D"}');
		const output = deepToWellFormedUnicode(input);
		const serialized = JSON.stringify(output);
		// No lone surrogate escapes in the serialized body.
		expect(LONE_SURROGATE_ESCAPE.test(serialized)).toBe(false);
		// The __proto__ key survived.
		expect(serialized).toContain('"__proto__"');
		expect(serialized).toContain('"marker":"kept"');
		// The lone surrogate in the sibling value was sanitized.
		expect((output as Record<string, unknown>).bad).toBe("�");
	});

	// #18081: Two distinct keys that sanitize to the same form should not
	// overwrite each other silently — first-write-wins.
	it("handles key collisions with first-write-wins policy", () => {
		// Both keys contain a lone surrogate at different positions, but both
		// surrogates replace to U+FFFD, so both keys sanitize to "a\ufffdb".
		const input = { "a\uD83Db": 1, "a\uDC80b": 2 };
		const output = deepToWellFormedUnicode(input);
		const keys = Object.keys(output);
		// Both keys sanitize to "a\ufffdb" — the first one wins.
		expect(keys).toEqual(["a\ufffdb"]);
		expect((output as Record<string, unknown>)["a\ufffdb"]).toBe(1);
	});

	// #18081: Dirty plain objects (with surrogates but no own __proto__) must
	// retain Object.prototype so downstream code that calls hasOwnProperty /
	// toString still works. The `"__proto__" in value` check is always true
	// for Object.prototype-backed objects, so this guards against a regression
	// where setPrototypeOf never fires.
	it("re-attaches Object.prototype on dirty plain objects without own __proto__ (#18081)", () => {
		const input = { message: "bad \uD83D" };
		const output = deepToWellFormedUnicode(input);
		expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
		// Verify prototype methods actually work.
		expect(
			(
				Object.prototype.hasOwnProperty.call as (
					o: unknown,
					k: string,
				) => boolean
			)(output, "message"),
		).toBe(true);
	});

	// #18081: Objects with symbol properties or function values are sanitized
	// copy-on-write (not in-place) to preserve SDK contract symbols and
	// callbacks without mutating or crashing on frozen inputs. The output is a
	// new object when sanitizing is needed; the same reference when clean.
	it("sanitizes string values and keys copy-on-write on objects with symbol properties (#18081)", () => {
		const sym = Symbol("test");
		const input = { description: "bad \uD83D", [sym]: 42 } as Record<
			PropertyKey,
			unknown
		>;
		const output = deepToWellFormedUnicode(input);
		// Copy-on-write: output is a new object (input is NOT mutated).
		expect(output).not.toBe(input);
		expect((input as Record<string, unknown>).description).toBe("bad \uD83D");
		expect((output as Record<string, unknown>).description).toBe("bad \uFFFD");
		// Symbol property survives on the clone.
		expect((output as Record<symbol, unknown>)[sym]).toBe(42);
	});

	it("returns the same reference for clean objects with symbol properties (#18081)", () => {
		const sym = Symbol("test");
		const input = { description: "clean", [sym]: 42 } as Record<
			PropertyKey,
			unknown
		>;
		const output = deepToWellFormedUnicode(input);
		expect(output).toBe(input);
	});

	it("sanitizes string values and keys copy-on-write on objects with function properties (#18081)", () => {
		const callback = () => "execute";
		const input = { description: "bad \uD83D", execute: callback } as Record<
			PropertyKey,
			unknown
		>;
		const output = deepToWellFormedUnicode(input);
		// Copy-on-write: output is a new object (input is NOT mutated).
		expect(output).not.toBe(input);
		expect((input as Record<string, unknown>).description).toBe("bad \uD83D");
		expect((output as Record<string, unknown>).description).toBe("bad \uFFFD");
		// Function property survives on the clone.
		expect((output as Record<string, unknown>).execute).toBe(callback);
	});

	// #18081 review: the function/symbol preservation branch must sanitize
	// object KEYS, not just values. A key containing a lone surrogate must be
	// sanitized — not silently passed through.
	it("sanitizes object keys containing lone surrogates on the function-preservation branch (#18081 review)", () => {
		const callback = () => "execute";
		const input = {
			execute: callback,
			"bad\uD83D": "ok",
			nested: { "schema\uD83D": "value" },
		} as Record<PropertyKey, unknown>;
		const output = deepToWellFormedUnicode(input);
		const serialized = JSON.stringify(output);
		expect(LONE_SURROGATE_ESCAPE.test(serialized)).toBe(false);
		// Functions preserved by reference.
		expect((output as Record<string, unknown>).execute).toBe(callback);
	});

	// #18081 review: frozen objects (e.g. prebuilt SDK tools) must not crash
	// — the branch is copy-on-write, not in-place mutation.
	it("does not throw on frozen objects with function properties (#18081 review)", () => {
		const frozen = Object.freeze({
			execute() {
				return "ok";
			},
			"bad\uD83D": "value",
		});
		const output = deepToWellFormedUnicode(frozen);
		const serialized = JSON.stringify(output);
		expect(LONE_SURROGATE_ESCAPE.test(serialized)).toBe(false);
	});
});

describe("#18025 wire regression: the captured Cerebras failure shape", () => {
	// The live 400 body was {"message":": Invalid JSON: lone leading surrogate
	// in hex escape...","code":"wrong_api_format"} — produced when a mid-emoji
	// slice left a lone \uD8xx code unit that JSON.stringify emitted as a bare
	// surrogate escape.
	it("a mid-emoji slice serializes to a body a strict parser rejects; the sanitized body is clean", () => {
		const toolResult = `web page title 🤖 with emoji`.slice(0, 16); // splits 🤖
		const rawBody = JSON.stringify({
			messages: [{ role: "tool", content: toolResult }],
		});
		expect(LONE_SURROGATE_ESCAPE.test(rawBody)).toBe(true); // the bug

		const sanitizedBody = JSON.stringify(
			deepToWellFormedUnicode({
				messages: [{ role: "tool", content: toolResult }],
			}),
		);
		expect(LONE_SURROGATE_ESCAPE.test(sanitizedBody)).toBe(false);
		expect(isWellFormed(sanitizedBody)).toBe(true);
		// Round-trips through a strict UTF-8 encode/decode (TextEncoder would
		// have replaced lone surrogates; a clean body is byte-stable).
		const bytes = new TextEncoder().encode(sanitizedBody);
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		expect(decoded).toBe(sanitizedBody);
		expect(JSON.parse(decoded)).toEqual({
			messages: [{ role: "tool", content: "web page title �" }],
		});
	});

	it("truncateWellFormed prevents the escape from ever forming", () => {
		const safe = truncateWellFormed("web page title 🤖 with emoji", 16);
		const body = JSON.stringify({
			messages: [{ role: "tool", content: safe }],
		});
		expect(LONE_SURROGATE_ESCAPE.test(body)).toBe(false);
	});
});
