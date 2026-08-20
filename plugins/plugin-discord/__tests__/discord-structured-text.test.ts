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
	normalizeDiscordMessageText,
} from "../discord-structured-text";

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
		const started = performance.now();
		expect(normalizeDiscordMessageText(cyclic)).toBe("");
		expect(performance.now() - started).toBeLessThan(50);
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

	it("fails closed on a 20k nest in under 50ms instead of RangeError", () => {
		const started = performance.now();
		try {
			normalizeDiscordMessageText(nestArray(20_000));
			expect.unreachable("walk should fail closed on a 20k nest");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe(
				DISCORD_STRUCTURED_TEXT_UNBOUNDED,
			);
			expect((error as Error).name).not.toBe("RangeError");
		}
		expect(performance.now() - started).toBeLessThan(50);

		const contentStarted = performance.now();
		try {
			normalizeDiscordMessageText(nestContent(8_000));
			expect.unreachable("walk should fail closed on an 8k content nest");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe(
				DISCORD_STRUCTURED_TEXT_UNBOUNDED,
			);
		}
		expect(performance.now() - contentStarted).toBeLessThan(50);
	});
});
