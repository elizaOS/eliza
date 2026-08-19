/**
 * Deterministic unit coverage for the well-formed Unicode helpers: truncation
 * must never split a surrogate pair (the #18025 failure mode — a mid-emoji
 * slice produced a lone leading surrogate that Cerebras's strict JSON parser
 * rejected with `wrong_api_format`), and the sanitizers must turn any lone
 * surrogate into U+FFFD so a serialized request body never carries a bare
 * \uD8xx escape. Also covers fail-closed depth / cycle / visit bounds on
 * `deepToWellFormedUnicode` (origin hung the model-call path with RangeError).
 */

import { describe, expect, it } from "vitest";
import { ElizaError } from "../errors.ts";
import {
	deepToWellFormedUnicode,
	MAX_WELL_FORMED_DEPTH,
	MAX_WELL_FORMED_VISITS,
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

	it("returns empty string for non-positive or non-finite budgets", () => {
		expect(truncateWellFormed("abc", 0)).toBe("");
		expect(truncateWellFormed("abc", -1)).toBe("");
		expect(truncateWellFormed("abc", Number.NaN)).toBe("");
		expect(truncateWellFormed("abc", Number.POSITIVE_INFINITY)).toBe("");
		expect(truncateWellFormed("abc", Number.NEGATIVE_INFINITY)).toBe("");
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

	it("returns short input unchanged and empty for non-positive or non-finite budgets", () => {
		expect(tailWellFormed("💀", 5)).toBe("💀");
		expect(tailWellFormed("abc", 0)).toBe("");
		expect(tailWellFormed("abc", -1)).toBe("");
		expect(tailWellFormed("abc", Number.NaN)).toBe("");
		expect(tailWellFormed("abc", Number.POSITIVE_INFINITY)).toBe("");
		expect(tailWellFormed("abc", Number.NEGATIVE_INFINITY)).toBe("");
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
		expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
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

	it("preserves non-enumerable callbacks and symbol descriptors when cloning", () => {
		const callback = () => "execute";
		const sdkMarker = Symbol("sdk-marker");
		const input = { "bad\uD83D": "value" } as Record<PropertyKey, unknown>;
		Object.defineProperty(input, "execute", {
			value: callback,
			writable: false,
			enumerable: false,
			configurable: false,
		});
		Object.defineProperty(input, sdkMarker, {
			value: 42,
			writable: false,
			enumerable: false,
			configurable: false,
		});

		const output = deepToWellFormedUnicode(input);

		expect(output).not.toBe(input);
		expect(Object.getOwnPropertyDescriptor(output, "execute")).toEqual(
			Object.getOwnPropertyDescriptor(input, "execute"),
		);
		expect(Object.getOwnPropertyDescriptor(output, sdkMarker)).toEqual(
			Object.getOwnPropertyDescriptor(input, sdkMarker),
		);
		expect(output.execute).toBe(callback);
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

	// #18081 review (2nd CHANGES_REQUESTED): the function/symbol-preserving
	// copy-on-write branch must use the same safe key-insertion strategy as
	// the plain-object branch — null-prototype object + defineProperty +
	// first-write-wins collision guard. Without it, an own `__proto__` data
	// key is silently lost (prototype mutation) and two keys that normalize
	// to the same form are last-write-wins instead of first-write-wins.
	it("preserves own __proto__ key as a data member on the function-preservation branch (#18081 review)", () => {
		// An own __proto__ data key (from JSON.parse) + execute() to select
		// the function/symbol-preserving copy-on-write branch.
		// A malformed sibling key ("bad\uD83D") forces `changed = true` so the
		// clone path actually executes — without it, sanitizeObjectPreservingDescriptors
		// early-returns the original input and the assertions would merely observe
		// the JSON.parse output, not the clone.
		const input = JSON.parse(
			'{"execute":"placeholder","__proto__":{"marker":"kept"},"bad\\uD83D":"sibling"}',
		) as Record<string, unknown>;
		// Replace the string with a real function to select the special branch.
		input.execute = () => "ok";

		const output = deepToWellFormedUnicode(input);

		// The clone path ran (the malformed key forced changed = true).
		expect(output).not.toBe(input);
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
		expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
	});

	it("preserves a null prototype while sanitizing", () => {
		const input = Object.assign(Object.create(null), { value: "bad \uD83D" });
		const output = deepToWellFormedUnicode(input);
		expect(output).not.toBe(input);
		expect(Object.getPrototypeOf(output)).toBeNull();
		expect(output.value).toBe("bad �");
	});

	it("handles normalized-key collisions with first-write-wins on the function-preservation branch (#18081 review)", () => {
		// execute() selects the function/symbol-preserving copy-on-write branch.
		// Both keys contain a lone surrogate that normalizes to U+FFFD, so
		// both sanitize to "a\uFFFDb".
		const input = {
			execute() {
				return "ok";
			},
			"a\uD83Db": 1,
			"a\uDC80b": 2,
		} as Record<string, unknown>;
		const output = deepToWellFormedUnicode(input) as Record<string, unknown>;
		const keys = Object.keys(output);
		// Both keys collapse to "a\uFFFDb" — the first one wins (value 1).
		expect(keys).toEqual(["execute", "a\uFFFDb"]);
		expect(output["a\uFFFDb"]).toBe(1);
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

describe("deepToWellFormedUnicode unbounded input", () => {
	function nestArray(depth: number): unknown {
		let value: unknown = ["ok"];
		for (let i = 0; i < depth; i++) {
			value = [value];
		}
		return value;
	}

	function nestObject(depth: number): unknown {
		let value: unknown = { s: "ok" };
		for (let i = 0; i < depth; i++) {
			value = { child: value };
		}
		return value;
	}

	it("sanitizes an honest nested provider body under the depth cap", () => {
		const input = nestObject(8);
		expect(deepToWellFormedUnicode(input)).toBe(input);
	});

	it("accepts a diamond DAG (shared child is not a cycle)", () => {
		const shared = { s: "ok" };
		const input = { a: shared, b: shared };
		expect(deepToWellFormedUnicode(input)).toBe(input);
	});

	it("throws WELL_FORMED_UNBOUNDED on a cyclic object", () => {
		const input: Record<string, unknown> = { a: "ok" };
		input.self = input;
		try {
			deepToWellFormedUnicode(input);
			expect.unreachable("cyclic object must fail closed");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe("WELL_FORMED_UNBOUNDED");
			expect((error as ElizaError).context?.reason).toBe("cycle");
		}
	});

	it("throws WELL_FORMED_UNBOUNDED on a cyclic array", () => {
		const input: unknown[] = ["ok"];
		input.push(input);
		try {
			deepToWellFormedUnicode(input);
			expect.unreachable("cyclic array must fail closed");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe("WELL_FORMED_UNBOUNDED");
			expect((error as ElizaError).context?.reason).toBe("cycle");
		}
	});

	it("throws WELL_FORMED_UNBOUNDED before a 20k-deep array can blow the stack", () => {
		const t0 = performance.now();
		try {
			deepToWellFormedUnicode(nestArray(20_000));
			expect.unreachable("20k-deep array must fail closed");
		} catch (error) {
			const ms = performance.now() - t0;
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe("WELL_FORMED_UNBOUNDED");
			expect((error as ElizaError).context?.reason).toBe("depth");
			expect(ms).toBeLessThan(50);
		}
	});

	it("accepts nesting exactly at the depth cap", () => {
		// nestArray(n) wraps n times around ["ok"], so n=63 is 64 containers.
		const input = nestArray(MAX_WELL_FORMED_DEPTH - 1);
		expect(deepToWellFormedUnicode(input)).toBe(input);
	});

	it(`throws WELL_FORMED_UNBOUNDED one past depth ${MAX_WELL_FORMED_DEPTH}`, () => {
		try {
			deepToWellFormedUnicode(nestArray(MAX_WELL_FORMED_DEPTH));
			expect.unreachable("depth cap must fail closed");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).context?.reason).toBe("depth");
		}
	});

	it("accepts a visit count exactly at the budget", () => {
		// Array node + (MAX-1) strings = MAX visits.
		const input = new Array<string>(MAX_WELL_FORMED_VISITS - 1).fill("ok");
		expect(deepToWellFormedUnicode(input)).toBe(input);
	});

	it("charges sparse array holes before provider serialization", () => {
		const exact = new Array(MAX_WELL_FORMED_VISITS - 1);
		expect(deepToWellFormedUnicode(exact)).toBe(exact);

		const oversized = new Array(MAX_WELL_FORMED_VISITS);
		expect(() => deepToWellFormedUnicode(oversized)).toThrowError(
			expect.objectContaining({
				code: "WELL_FORMED_UNBOUNDED",
				context: expect.objectContaining({ reason: "visits" }),
			}),
		);
	});

	it("rejects an over-budget object before invoking an enumerable getter", () => {
		const input: Record<string, unknown> = {};
		for (let i = 0; i < MAX_WELL_FORMED_VISITS - 1; i++) {
			input[`key-${i}`] = "ok";
		}
		let getterCalls = 0;
		Object.defineProperty(input, "hostile", {
			enumerable: true,
			get() {
				getterCalls += 1;
				return "should not run";
			},
		});

		expect(() => deepToWellFormedUnicode(input)).toThrow(
			/WELL_FORMED|visit budget/i,
		);
		expect(getterCalls).toBe(0);
	});

	it("throws WELL_FORMED_UNBOUNDED on a visit-budget array of strings", () => {
		const input = new Array<string>(MAX_WELL_FORMED_VISITS).fill("ok");
		try {
			deepToWellFormedUnicode(input);
			expect.unreachable("visit budget must fail closed");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe("WELL_FORMED_UNBOUNDED");
			expect((error as ElizaError).context?.reason).toBe("visits");
		}
	});
});
