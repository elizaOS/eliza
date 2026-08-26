/**
 * Deterministic unit coverage for the well-formed Unicode helpers: truncation
 * must never split a surrogate pair (the #18025 failure mode — a mid-emoji
 * slice produced a lone leading surrogate that Cerebras's strict JSON parser
 * rejected with `wrong_api_format`), and the sanitizers must turn any lone
 * surrogate into U+FFFD so a serialized request body never carries a bare
 * \uD8xx escape. Also covers fail-closed depth, cycle, and visit bounds.
 */

import { describe, expect, it } from "vitest";
import { ElizaError } from "../errors.ts";
import {
	assertSchemaAnnotationsSerializable,
	deepToWellFormedUnicode,
	MAX_WELL_FORMED_DEPTH,
	MAX_WELL_FORMED_VISITS,
	tailWellFormed,
	toWellFormedUnicode,
	truncateWellFormed,
	wellFormedUnicodeSchemaStructure,
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
		expect(truncateWellFormed(null as unknown as string, 10)).toBe("");
		expect(truncateWellFormed(undefined as unknown as string, 10)).toBe("");
	});

	it("preserves a pre-existing lone surrogate (sanitizing is not its job)", () => {
		const malformed = `x\uD83D`;
		expect(truncateWellFormed(`${malformed}yz`, 2)).toBe(malformed);
	});
});

describe("toWellFormedUnicode defensive handling", () => {
	it("returns empty string for non-string inputs", () => {
		expect(toWellFormedUnicode(null as unknown as string)).toBe("");
		expect(toWellFormedUnicode(undefined as unknown as string)).toBe("");
		expect(toWellFormedUnicode(123 as unknown as string)).toBe("");
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
		try {
			deepToWellFormedUnicode(nestArray(20_000));
			expect.unreachable("20k-deep array must fail closed");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe("WELL_FORMED_UNBOUNDED");
			expect((error as ElizaError).context?.reason).toBe("depth");
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

	it("rejects an enumerable getter without invoking it", () => {
		let getterCalls = 0;
		const input = {};
		Object.defineProperty(input, "hostile", {
			enumerable: true,
			get() {
				getterCalls += 1;
				return "observed";
			},
		});

		expect(() => deepToWellFormedUnicode(input)).toThrowError(
			expect.objectContaining({
				code: "WELL_FORMED_UNSAFE_VALUE",
				context: { operation: "accessor", propertyName: "hostile" },
			}),
		);
		expect(getterCalls).toBe(0);
	});

	it("wraps revoked proxy reflection as a typed wire failure", () => {
		const { proxy, revoke } = Proxy.revocable({ value: "opaque" }, {});
		revoke();

		try {
			deepToWellFormedUnicode(proxy);
			expect.unreachable("revoked proxy must fail closed");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe("WELL_FORMED_UNSAFE_VALUE");
			expect((error as ElizaError).context).toEqual({
				operation: "reflection",
			});
			expect((error as Error).cause).toBeInstanceOf(TypeError);
		}
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

describe("wellFormedUnicodeSchemaStructure key safety", () => {
	function nestProperties(depth: number): Record<string, unknown> {
		let node: Record<string, unknown> = { type: "string" };
		for (let i = 0; i < depth; i++) {
			node = { type: "object", properties: { x: node } };
		}
		return node;
	}

	it("preserves an own __proto__ properties key as data, not prototype mutation", () => {
		const dirtyProps = JSON.parse(
			'{"__proto__":{"minProperties":1},"sib":{"type":"string","description":"\\uD800"}}',
		);
		const output = wellFormedUnicodeSchemaStructure({
			type: "object",
			properties: dirtyProps,
		});
		const props = (output as { properties: Record<string, unknown> })
			.properties;
		const desc = Object.getOwnPropertyDescriptor(props, "__proto__");
		expect(desc).toBeDefined();
		expect(desc?.enumerable).toBe(true);
		// The projected map must not inherit caller-controlled members.
		expect("minProperties" in props).toBe(false);
		expect(Object.getPrototypeOf(props)).toBe(Object.prototype);
		// JSON round-trip keeps the key as a data member.
		expect(JSON.stringify(output)).toContain('"__proto__"');
	});

	it("preserves __proto__ through the properties-map entry walk", () => {
		const dirtyMap = JSON.parse(
			'{"__proto__":{"polluted":true},"a":{"type":"string","description":"\\uD800"}}',
		);
		const output = wellFormedUnicodeSchemaStructure({
			type: "object",
			properties: dirtyMap,
		});
		const props = (output as { properties: Record<string, unknown> })
			.properties;
		expect(Object.getOwnPropertyDescriptor(props, "__proto__")).toBeDefined();
		expect(Object.getPrototypeOf(props)).toBe(Object.prototype);
	});

	it("applies first-write-wins when two keys collapse onto one sanitized form", () => {
		const output = wellFormedUnicodeSchemaStructure({
			type: "object",
			properties: {
				"a\uD83Db": { type: "string" },
				"a\uDC80b": { type: "number" },
			},
		});
		const props = (output as { properties: Record<string, unknown> })
			.properties;
		expect(Object.keys(props)).toEqual(["a\ufffdb"]);
		expect((props["a\ufffdb"] as { type: string }).type).toBe("string");
	});

	it("rejects an accessor under the properties map without invoking it", () => {
		let reads = 0;
		const holder: Record<string, unknown> = {};
		Object.defineProperty(holder, "foo", {
			enumerable: true,
			get() {
				reads += 1;
				return { type: "string" };
			},
		});
		try {
			wellFormedUnicodeSchemaStructure({ type: "object", properties: holder });
			expect.unreachable("accessor under properties must fail closed");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe("WELL_FORMED_UNSAFE_VALUE");
			expect((error as ElizaError).context).toEqual({
				operation: "accessor",
				propertyName: "foo",
			});
		}
		expect(reads).toBe(0);
	});

	it("charges sparse array holes under non-schema keywords before serialization", () => {
		const sparse = new Array(MAX_WELL_FORMED_VISITS + 1);
		sparse[0] = "ok";
		try {
			wellFormedUnicodeSchemaStructure({
				type: "object",
				properties: {},
				customKey: sparse,
			});
			expect.unreachable("sparse hole budget bypass must fail closed");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe("WELL_FORMED_UNBOUNDED");
			expect((error as ElizaError).context?.reason).toBe("visits");
		}
	});

	it("fails closed on a numeric accessor in the generic-array branch", () => {
		let reads = 0;
		const hostile: unknown[] = ["ok"];
		Object.defineProperty(hostile, 1, {
			enumerable: true,
			get() {
				reads += 1;
				return "observed";
			},
		});
		try {
			wellFormedUnicodeSchemaStructure({
				type: "object",
				customKey: hostile,
			});
			expect.unreachable("numeric accessor must fail closed");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe("WELL_FORMED_UNSAFE_VALUE");
			expect((error as ElizaError).context).toEqual({
				operation: "accessor",
				propertyName: "1",
			});
		}
		expect(reads).toBe(0);
	});

	it("fails closed on numeric accessors in schema-array keyword branches", () => {
		// anyOf/prefixItems previously treated an accessor descriptor like a
		// hole: changed stayed false and the ORIGINAL array survived to
		// provider serialization, which invoked the getter.
		for (const keyword of ["anyOf", "prefixItems"] as const) {
			let reads = 0;
			const hostile: unknown[] = [];
			Object.defineProperty(hostile, 0, {
				enumerable: true,
				get() {
					reads += 1;
					return { type: "string" };
				},
			});
			try {
				wellFormedUnicodeSchemaStructure({
					type: "object",
					[keyword]: hostile,
				});
				expect.unreachable(`${keyword} accessor must fail closed`);
			} catch (error) {
				expect(error).toBeInstanceOf(ElizaError);
				expect((error as ElizaError).code).toBe("WELL_FORMED_UNSAFE_VALUE");
				expect((error as ElizaError).context).toEqual({
					operation: "accessor",
					propertyName: "0",
				});
			}
			expect(reads).toBe(0);
		}
	});

	it("does not double-charge present elements of a schema keyword array", () => {
		// A schema-array wrapper costs 1 + length like every other branch;
		// double-charging would push this ~40k-visit payload to ~80k and
		// reject honest dense anyOf arrays at half their declared budget.
		const dense = new Array(40_000).fill("ok");
		expect(
			wellFormedUnicodeSchemaStructure({ type: "object", anyOf: dense }),
		).toBeDefined();
	});

	it("admits a schema keyword array exactly at the visit budget and rejects one past", () => {
		// root(1) + object(1) + wrapper's `length || 1` charge with members
		// prepaid inside it = 65,536 exactly.
		const atBudget = new Array(MAX_WELL_FORMED_VISITS - 2).fill("ok");
		expect(
			wellFormedUnicodeSchemaStructure({ type: "object", anyOf: atBudget }),
		).toBeDefined();

		try {
			wellFormedUnicodeSchemaStructure({
				type: "object",
				anyOf: new Array(MAX_WELL_FORMED_VISITS - 1).fill("ok"),
			});
			expect.unreachable("one past the budget must fail closed");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe("WELL_FORMED_UNBOUNDED");
			expect((error as ElizaError).context?.reason).toBe("visits");
		}
	});

	it("does not double-charge present elements of a dense array", () => {
		// An array costs 1 + length: the hole charge covers present elements,
		// so a dense 40k-element array must pass (a double-charge would push
		// it past the 65,536 budget and regress honest dense payloads).
		const dense = new Array(40_000).fill("ok");
		expect(
			wellFormedUnicodeSchemaStructure({ type: "object", customKey: dense }),
		).toBeDefined();
	});

	it("admits a dense array exactly at the visit budget and rejects one past", () => {
		// root(1) + customKey node(1) + array(1) + length = 65,536 exactly.
		const atBudget = new Array(MAX_WELL_FORMED_VISITS - 3).fill("ok");
		expect(
			wellFormedUnicodeSchemaStructure({ type: "object", customKey: atBudget }),
		).toBeDefined();

		const overBudget = new Array(MAX_WELL_FORMED_VISITS - 2).fill("ok");
		try {
			wellFormedUnicodeSchemaStructure({
				type: "object",
				customKey: overBudget,
			});
			expect.unreachable("one past the dense budget must fail closed");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe("WELL_FORMED_UNBOUNDED");
			expect((error as ElizaError).context?.reason).toBe("visits");
		}
	});

	it("keeps the schema depth authority intact for honest deep schemas", () => {
		// The leaf schema sits at wrap-count depth in the walker's accounting,
		// so MAX_WELL_FORMED_DEPTH wraps is exactly at the authority.
		const atBudget = nestProperties(MAX_WELL_FORMED_DEPTH);
		expect(wellFormedUnicodeSchemaStructure(atBudget)).toBe(atBudget);

		try {
			wellFormedUnicodeSchemaStructure(
				nestProperties(MAX_WELL_FORMED_DEPTH + 1),
			);
			expect.unreachable("one past the walker authority must fail closed");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe("WELL_FORMED_UNBOUNDED");
			expect((error as ElizaError).context?.reason).toBe("depth");
			expect((error as ElizaError).context?.max).toBe(MAX_WELL_FORMED_DEPTH);
		}
	});
});

describe("assertSchemaAnnotationsSerializable keyword-aware wire check", () => {
	it("admits a full-authority schema whose annotation subtrees stay shallow", () => {
		function nest(depth: number): Record<string, unknown> {
			let node: Record<string, unknown> = { type: "string" };
			for (let i = 0; i < depth; i++) {
				node = { type: "object", properties: { x: node } };
			}
			return node;
		}
		const tools = [
			{
				name: "probe",
				parameters: nest(MAX_WELL_FORMED_DEPTH - 3),
			},
		];
		// Uniform charging: a walker-full-authority schema costs up to 2x its
		// node depth here, so the doubled cap must admit it unchanged.
		expect(() =>
			assertSchemaAnnotationsSerializable(tools, {
				maxDepth: 2 * MAX_WELL_FORMED_DEPTH + 8,
			}),
		).not.toThrow();
	});

	it("rejects hostile data hidden inside an annotation subtree without invoking it", () => {
		let reads = 0;
		const hostile = {} as Record<string, unknown>;
		Object.defineProperty(hostile, "boom", {
			enumerable: true,
			get() {
				reads += 1;
				return "observed";
			},
		});
		const tools = [
			{
				name: "probe",
				parameters: {
					type: "object",
					default: hostile,
					properties: {},
				},
			},
		];
		try {
			assertSchemaAnnotationsSerializable(tools, {
				maxDepth: 2 * MAX_WELL_FORMED_DEPTH + 8,
			});
			expect.unreachable("hostile annotation data must fail closed");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toMatch(/^WELL_FORMED_/);
		}
		expect(reads).toBe(0);
	});

	it("rejects accessor-carrying annotation data without invoking it", () => {
		let reads = 0;
		const holder = {} as Record<string, unknown>;
		Object.defineProperty(holder, "lazyValue", {
			enumerable: true,
			get() {
				reads += 1;
				return "observed";
			},
		});
		const tools = [
			{
				name: "probe",
				parameters: { type: "object", default: [holder], properties: {} },
			},
		];
		try {
			assertSchemaAnnotationsSerializable(tools, {
				maxDepth: 2 * MAX_WELL_FORMED_DEPTH + 8,
			});
			expect.unreachable("annotation accessors must fail closed");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe("WELL_FORMED_UNSAFE_VALUE");
			expect((error as ElizaError).context).toEqual({
				operation: "accessor",
				propertyName: "lazyValue",
			});
		}
		expect(reads).toBe(0);
	});

	it("rewrites a lone-surrogate annotation extension key onto the wire", () => {
		const bad = "x-\ud800";
		const schema: Record<string, unknown> = { type: "object" };
		schema[bad] = { opaque: "ok" };
		const out = wellFormedUnicodeSchemaStructure(schema) as Record<
			string,
			unknown
		>;
		// The rewrite must flip `changed`: returning the original reference
		// shipped the lone surrogate to strict providers.
		expect(out).not.toBe(schema);
		const keys = Object.keys(out);
		expect(keys).toContain("x-\uFFFD");
		expect(keys).not.toContain(bad);
		expect(JSON.stringify(out)).not.toMatch(/\\ud800/i);
	});

	it("charges a sparse annotation array by its logical length", () => {
		// Holes are invisible to Reflect.ownKeys but JSON.stringify walks
		// every index; the visit budget must cover the full logical length.
		const sparse: unknown[] = [];
		sparse.length = MAX_WELL_FORMED_VISITS * 4;
		sparse[0] = "a";
		sparse[MAX_WELL_FORMED_VISITS * 4 - 1] = "b";
		expect(() =>
			assertSchemaAnnotationsSerializable(
				[{ name: "probe", parameters: { type: "object", default: sparse } }],
				{ maxDepth: 2 * MAX_WELL_FORMED_DEPTH + 8 },
			),
		).toThrowError(expect.objectContaining({ code: "WELL_FORMED_UNBOUNDED" }));
	});

	it("admits a dense annotation array exactly at the visit budget and rejects one past", () => {
		// root(1) + tool(1) + name(1) + parameters(1) + type(1) + array(1) +
		// length = 65,536 exactly.
		const tools = (length: number) => [
			{
				name: "probe",
				parameters: { type: "object", default: new Array(length).fill("ok") },
			},
		];
		expect(() =>
			assertSchemaAnnotationsSerializable(tools(MAX_WELL_FORMED_VISITS - 6), {
				maxDepth: 2 * MAX_WELL_FORMED_DEPTH + 8,
			}),
		).not.toThrow();
		expect(() =>
			assertSchemaAnnotationsSerializable(tools(MAX_WELL_FORMED_VISITS - 5), {
				maxDepth: 2 * MAX_WELL_FORMED_DEPTH + 8,
			}),
		).toThrowError(expect.objectContaining({ code: "WELL_FORMED_UNBOUNDED" }));
	});

	it("rejects deep hostile nesting inside an annotation subtree", () => {
		function nestAnnotation(depth: number): unknown {
			let value: unknown = { s: "ok" };
			for (let i = 0; i < depth; i++) {
				value = { child: value };
			}
			return value;
		}
		const tools = [
			{
				name: "probe",
				parameters: {
					type: "object",
					default: nestAnnotation(2 * MAX_WELL_FORMED_DEPTH + 12),
					properties: {},
				},
			},
		];
		try {
			assertSchemaAnnotationsSerializable(tools, {
				maxDepth: 2 * MAX_WELL_FORMED_DEPTH + 8,
			});
			expect.unreachable("over-deep annotation data must fail closed");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe("WELL_FORMED_UNBOUNDED");
			expect((error as ElizaError).context?.reason).toBe("depth");
		}
	});

	it("rejects annotation cycles without dispatch", () => {
		const annotation: Record<string, unknown> = { value: "opaque" };
		annotation.self = annotation;
		const tools = [
			{ name: "probe", parameters: { type: "object", default: annotation } },
		];
		expect(() =>
			assertSchemaAnnotationsSerializable(tools, {
				maxDepth: 2 * MAX_WELL_FORMED_DEPTH + 8,
			}),
		).toThrowError(expect.objectContaining({ code: "WELL_FORMED_UNBOUNDED" }));
	});

	it("never rejects wrapper-region lazy SDK accessors on a ToolSet", () => {
		let reads = 0;
		const toolSet: Record<string, unknown> = {
			probe: {
				description: "probe",
				parameters: { type: "object", properties: {} },
				get inputSchema() {
					reads += 1;
					return { jsonSchema: { type: "object", properties: {} } };
				},
			},
		};
		expect(() =>
			assertSchemaAnnotationsSerializable(toolSet, {
				maxDepth: 2 * MAX_WELL_FORMED_DEPTH + 8,
			}),
		).not.toThrow();
		expect(reads).toBe(0);
	});

	it("bounds a hostile deep wrapper structure before dispatch", () => {
		function nestWrappers(depth: number): unknown {
			let value: unknown = { type: "object", properties: {} };
			for (let i = 0; i < depth; i++) {
				value = { nestedToolWrapper: value };
			}
			return value;
		}
		const tools = [
			{
				name: "probe",
				parameters: nestWrappers(2 * MAX_WELL_FORMED_DEPTH + 12),
			},
		];
		try {
			assertSchemaAnnotationsSerializable(tools, {
				maxDepth: 2 * MAX_WELL_FORMED_DEPTH + 8,
			});
			expect.unreachable("over-deep wrapper structure must fail closed");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe("WELL_FORMED_UNBOUNDED");
			expect((error as ElizaError).context?.reason).toBe("depth");
		}
	});

	it("charges repeated schema-key-named wrapper nesting (no name-based exemptions)", () => {
		// Hostile wrappers can nest under keys NAMED like schema keywords to
		// dodge any name-based free-edge rule; uniform charging must bound
		// them anyway. Depth far below the doubled cap still fails closed.
		function nestPropertiesWrappers(depth: number): unknown {
			let value: unknown = { type: "object", properties: {} };
			for (let i = 0; i < depth; i++) {
				value = { properties: { nested: value } };
			}
			return value;
		}
		const tools = [
			{
				name: "probe",
				parameters: nestPropertiesWrappers(2 * MAX_WELL_FORMED_DEPTH + 4),
			},
		];
		try {
			assertSchemaAnnotationsSerializable(tools, {
				maxDepth: 2 * MAX_WELL_FORMED_DEPTH + 8,
			});
			expect.unreachable("schema-key-named wrapper nesting must be charged");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe("WELL_FORMED_UNBOUNDED");
			expect((error as ElizaError).context?.reason).toBe("depth");
		}
	});

	it("admits an honest schema at the walker's full authority through the same uniform charging", () => {
		// The honest counterpart of the spoof test above: a real properties
		// chain at the walkers' full node depth passes the doubled cap.
		function nest(depth: number): Record<string, unknown> {
			let node: unknown = { type: "string" };
			for (let i = 0; i < depth; i++) {
				node = { type: "object", properties: { x: node } };
			}
			return node as Record<string, unknown>;
		}
		const tools = [
			{ name: "probe", parameters: nest(MAX_WELL_FORMED_DEPTH - 3) },
		];
		expect(() =>
			assertSchemaAnnotationsSerializable(tools, {
				maxDepth: 2 * MAX_WELL_FORMED_DEPTH + 8,
			}),
		).not.toThrow();
	});

	it("bounds an extremely wide wrapper structure before dispatch", () => {
		const wide: Record<string, unknown> = {};
		for (let i = 0; i < MAX_WELL_FORMED_VISITS; i++) {
			wide[`wrapperKey${i}`] = { type: "object", properties: {} };
		}
		const tools = [{ name: "probe", metadata: wide }];
		try {
			assertSchemaAnnotationsSerializable(tools, {
				maxDepth: 2 * MAX_WELL_FORMED_DEPTH + 8,
			});
			expect.unreachable("over-wide wrapper structure must fail closed");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe("WELL_FORMED_UNBOUNDED");
			expect((error as ElizaError).context?.reason).toBe("visits");
		}
	});
});
