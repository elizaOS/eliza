/** Surrogate safety for connector prefix and suffix splitting in message.ts. */
import { describe, expect, test } from "vitest";
import { splitConnectorPrefix, splitConnectorSuffix } from "./message.ts";

describe("message action connector split surrogate safety", () => {
	test("prefix split with emoji in target remainder stays well-formed", () => {
		const fox = "🦊";
		const input = `discord:general-${fox}`;
		const res = splitConnectorPrefix(input);
		expect(res).toEqual({ source: "discord", target: `general-${fox}` });
	});

	test("suffix split with emoji in target body stays well-formed", () => {
		const fox = "🦊";
		const input = `hello world ${fox} on discord`;
		const res = splitConnectorSuffix(input);
		expect(res).toEqual({ source: "discord", target: `hello world ${fox}` });
	});

	test("lone surrogates in prefix and suffix targets are replaced exactly", () => {
		for (const surrogate of ["\ud800", "\udfff"]) {
			expect(splitConnectorPrefix(`discord:bad ${surrogate} channel`)).toEqual({
				source: "discord",
				target: "bad � channel",
			});
			expect(
				splitConnectorSuffix(`bad ${surrogate} channel on discord`),
			).toEqual({
				source: "discord",
				target: "bad � channel",
			});
		}
	});

	test("sweep whitespace offsets with emojis stay well-formed", () => {
		const fox = "🦊";
		for (let spaces = 1; spaces <= 5; spaces++) {
			const input = `topic ${fox}${" ".repeat(spaces)}on slack`;
			const res = splitConnectorSuffix(input);
			expect(res).toEqual({ source: "slack", target: `topic ${fox}` });
			expect(() => JSON.stringify(res)).not.toThrow();
		}
	});
});
