/**
 * Deterministic tests for the Discord structured-content text walk. No live
 * Discord gateway: the walker is the production outbound renderer.
 */
import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";

import {
	DISCORD_STRUCTURED_TEXT_UNBOUNDED,
	MAX_DISCORD_STRUCTURED_TEXT_DEPTH,
	MAX_DISCORD_STRUCTURED_TEXT_NODES,
} from "../discord-structured-text";
import { normalizeDiscordMessageText } from "../utils";

function nestArray(depth: number, leaf: unknown = "leaf"): unknown {
	let value: unknown = leaf;
	for (let index = 0; index < depth; index += 1) {
		value = [value];
	}
	return value;
}

function nestContent(depth: number): unknown {
	let value: unknown = { text: "hi" };
	for (let index = 0; index < depth; index += 1) {
		value = { content: value };
	}
	return value;
}

/** Observes production reflection without replacing the renderer or its input data. */
function observeInspections<T extends object>(
	value: T,
	inspections: { count: number },
): T {
	return new Proxy(value, {
		getOwnPropertyDescriptor(target, key) {
			inspections.count += 1;
			// Stop a regressed walk deterministically before it can exhaust the stack.
			if (inspections.count > 1_000) {
				throw new Error("renderer inspected an excessive input prefix");
			}
			return Reflect.getOwnPropertyDescriptor(target, key);
		},
	});
}

describe("normalizeDiscordMessageText", () => {
	it("renders honest scalars, lists, and nested content keys", () => {
		expect(normalizeDiscordMessageText("hello")).toBe("hello");
		expect(normalizeDiscordMessageText({ text: "hello" })).toBe("hello");
		expect(normalizeDiscordMessageText({ content: { text: "hello" } })).toBe(
			"hello",
		);
		expect(normalizeDiscordMessageText(["a", "b"])).toBe("a\n\nb");
		expect(normalizeDiscordMessageText({ parts: [{ text: "p" }] })).toBe("p");
		expect(normalizeDiscordMessageText({ title: "t" })).toBe("t");
	});

	it(`accepts a ${MAX_DISCORD_STRUCTURED_TEXT_DEPTH}-deep array nest`, () => {
		expect(
			normalizeDiscordMessageText(nestArray(MAX_DISCORD_STRUCTURED_TEXT_DEPTH)),
		).toBe("leaf");
		expect(
			normalizeDiscordMessageText(
				nestContent(MAX_DISCORD_STRUCTURED_TEXT_DEPTH - 2),
			),
		).toBe("hi");
	});

	it("does not invent an over-depth child for an empty boundary object", () => {
		expect(
			normalizeDiscordMessageText(
				nestArray(MAX_DISCORD_STRUCTURED_TEXT_DEPTH, {}),
			),
		).toBe("");
	});

	it(`throws ${DISCORD_STRUCTURED_TEXT_UNBOUNDED} one past depth ${MAX_DISCORD_STRUCTURED_TEXT_DEPTH}`, () => {
		try {
			normalizeDiscordMessageText(
				nestArray(MAX_DISCORD_STRUCTURED_TEXT_DEPTH + 1),
			);
			expect.unreachable("walk should fail closed on over-budget depth");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe(
				DISCORD_STRUCTURED_TEXT_UNBOUNDED,
			);
		}
	});

	it(`throws ${DISCORD_STRUCTURED_TEXT_UNBOUNDED} past ${MAX_DISCORD_STRUCTURED_TEXT_NODES} sparse holes`, () => {
		const sparse: unknown[] = [];
		sparse[MAX_DISCORD_STRUCTURED_TEXT_NODES] = "x";
		try {
			normalizeDiscordMessageText(sparse);
			expect.unreachable(
				"walk should fail closed on over-budget sparse length",
			);
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe(
				DISCORD_STRUCTURED_TEXT_UNBOUNDED,
			);
		}
	});

	it("skips cycles without hanging", () => {
		const cyclic: { content?: unknown } = {};
		cyclic.content = cyclic;
		const inspections = { count: 0 };
		const observed = observeInspections(cyclic, inspections);
		cyclic.content = observed;
		expect(normalizeDiscordMessageText(observed)).toBe("");
		expect(inspections.count).toBeGreaterThan(0);
		expect(inspections.count).toBeLessThanOrEqual(1_000);
	});

	it("does not invoke accessors while walking", () => {
		let invoked = 0;
		const hostile = {
			safe: "ok",
			get text() {
				invoked += 1;
				return nestArray(20_000);
			},
		};
		expect(normalizeDiscordMessageText(hostile)).toBe("");
		expect(invoked).toBe(0);
	});

	it("fails typed on own array accessors without invoking them", () => {
		let invoked = 0;
		const ownAccessor = ["safe"];
		Object.defineProperty(ownAccessor, "0", {
			get() {
				invoked += 1;
				return "unsafe";
			},
		});

		expect(() => normalizeDiscordMessageText(ownAccessor)).toThrowError(
			expect.objectContaining({ code: DISCORD_STRUCTURED_TEXT_UNBOUNDED }),
		);
		expect(invoked).toBe(0);
	});

	it("skips inherited array accessors without invoking them", () => {
		let invoked = 0;
		const inheritedAccessor = new Array<unknown>(1);
		Object.setPrototypeOf(inheritedAccessor, {
			get 0() {
				invoked += 1;
				return "unsafe";
			},
		});

		expect(normalizeDiscordMessageText(inheritedAccessor)).toBe("");
		expect(invoked).toBe(0);
	});

	it("does not invoke ordinary Proxy get or has traps", () => {
		let gets = 0;
		let hasChecks = 0;
		const proxied = new Proxy(["safe"], {
			get() {
				gets += 1;
				throw new Error("ordinary get must not run");
			},
			has() {
				hasChecks += 1;
				throw new Error("ordinary has must not run");
			},
		});

		expect(normalizeDiscordMessageText(proxied)).toBe("safe");
		expect(gets).toBe(0);
		expect(hasChecks).toBe(0);
	});

	it("translates hostile reflection and revoked Proxies to the typed error", () => {
		const hostile = new Proxy(
			{},
			{
				getOwnPropertyDescriptor() {
					throw new Error("hostile reflection");
				},
			},
		);
		const revocable = Proxy.revocable([], {});
		revocable.revoke();

		for (const value of [hostile, revocable.proxy]) {
			try {
				normalizeDiscordMessageText(value);
				expect.unreachable("hostile Proxy should fail closed");
			} catch (error) {
				expect(error).toBeInstanceOf(ElizaError);
				expect((error as ElizaError).code).toBe(
					DISCORD_STRUCTURED_TEXT_UNBOUNDED,
				);
			}
		}
	});

	it("preserves duplicate suppression for repeated object references", () => {
		const shared = { text: "once" };
		expect(normalizeDiscordMessageText([shared, shared])).toBe("once");
	});

	it.each(["array", "content"] as const)(
		"rejects deep %s input after bounded inspection without returning partial text",
		(kind) => {
			const inspections = { count: 0 };
			let value: unknown = "complete leaf";
			const depth = kind === "array" ? 20_000 : 8_000;
			for (let index = 0; index < depth; index += 1) {
				value = observeInspections(
					kind === "array" ? [value] : { content: value },
					inspections,
				);
			}
			try {
				normalizeDiscordMessageText(["valid prefix", value]);
				expect.unreachable("over-depth input must reject the entire message");
			} catch (error) {
				expect(error).toBeInstanceOf(ElizaError);
				expect((error as ElizaError).code).toBe(
					DISCORD_STRUCTURED_TEXT_UNBOUNDED,
				);
				expect((error as Error).name).not.toBe("RangeError");
			}
			expect(inspections.count).toBeGreaterThan(0);
			expect(inspections.count).toBeLessThanOrEqual(1_000);
		},
	);

	it("preserves the complete supported leaf regardless of its text length", () => {
		const text = `${"complete content ".repeat(10_000)}END`;
		expect(
			normalizeDiscordMessageText(
				nestArray(MAX_DISCORD_STRUCTURED_TEXT_DEPTH, text),
			),
		).toBe(text);
	});
});
