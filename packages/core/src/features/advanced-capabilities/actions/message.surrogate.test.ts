/** Surrogate safety for connector target routing and splitting in message.ts. */
import { describe, expect, test } from "vitest";
import type { MessageConnector } from "../../../types/index.ts";
import {
	inferSourceFromTarget,
	splitConnectorPrefix,
	splitConnectorSuffix,
} from "./message.ts";

function connector(source: string): MessageConnector {
	return {
		source,
		label: source,
		capabilities: ["send_message"],
		supportedTargetKinds: [],
		contexts: [],
	};
}

const connectors = [connector("discord"), connector("slack")];

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
			expect(
				inferSourceFromTarget(`discord:bad ${surrogate} channel`, connectors),
			).toEqual({
				source: "discord",
				target: "bad � channel",
			});
			expect(
				inferSourceFromTarget(
					`bad ${surrogate} channel on discord`,
					connectors,
				),
			).toEqual({
				source: "discord",
				target: "bad � channel",
			});
		}
	});

	test("targets matching no connector are still sanitized", () => {
		for (const surrogate of ["\ud800", "\udfff"]) {
			const res = inferSourceFromTarget(`bad ${surrogate} channel`, connectors);
			expect(res).toEqual({ target: "bad � channel" });
			expect(() => JSON.stringify(res)).not.toThrow();
		}
		// A connector-shaped prefix whose source matches nothing falls through too.
		expect(
			inferSourceFromTarget("nowhere:bad \ud800 channel", connectors),
		).toEqual({ target: "nowhere:bad � channel" });
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
