/** Tests deterministic action-route fixtures used by real scenario harnesses. */

import { describe, expect, it } from "vitest";
import { ModelType } from "../../types/model.ts";
import {
	actionSlug,
	finalMessageUserText,
	matchesScenarioInput,
	registerStrictActionRouteFixtures,
	stage1ResponseHandlerFixture,
	strictActionRouteFixtures,
} from "../deterministic-action-fixtures.ts";

function stage1JsonEnvelope(content: unknown): string {
	return `message:user:\n${JSON.stringify(content)}`;
}

describe("finalMessageUserText", () => {
	it("strips the message:user: marker", () => {
		expect(finalMessageUserText("prefix message:user:\nHello there")).toBe(
			"Hello there",
		);
	});

	it("returns the input unchanged when no marker", () => {
		expect(finalMessageUserText("plain text")).toBe("plain text");
	});

	it("extracts text after the external-content separator", () => {
		const value =
			"message:user:\n<<<EXTERNAL_UNTRUSTED_CONTENT>>>\nignored\n---\nREAL USER TEXT\n<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>";
		expect(finalMessageUserText(value)).toBe("REAL USER TEXT");
	});

	it("returns full envelope text when no separator", () => {
		const value =
			"message:user:\n<<<EXTERNAL_UNTRUSTED_CONTENT>>>\njust this\n<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>";
		expect(finalMessageUserText(value)).toBe("just this");
	});

	it("trims the trailing provider boundary", () => {
		const value = "message:user:\nBuy 10 apples\n\nevent: user_message";
		expect(finalMessageUserText(value)).toBe("Buy 10 apples");
	});

	it("selects the final top-level user block in a legacy multi-message prompt", () => {
		const value = [
			"prior_message:user:\nBuy pears",
			"current_turn_boundary:\nOnly the final message is current.",
			"message:user:\nBuy apples",
		].join("\n\n");
		expect(finalMessageUserText(value)).toBe("Buy apples");
	});

	it("extracts exact text from the current Stage-1 JSON message envelope", () => {
		const value = stage1JsonEnvelope({
			text: "Buy 10 apples",
			source: "scenario",
			channelType: "DM",
		});
		expect(finalMessageUserText(value)).toBe("Buy 10 apples");
	});

	it("decodes only the outer Stage-1 JSON message envelope", () => {
		const literalJson = JSON.stringify({ text: "literal user JSON" });
		const value = stage1JsonEnvelope({
			text: literalJson,
			source: "scenario",
			channelType: "DM",
		});
		expect(finalMessageUserText(value)).toBe(literalJson);
	});

	it.each([
		'{"label":"old","label":"new"}',
		'{"text":"other","te\\u0078t":"still metadata"}',
		'{"source":"old","source":"new","channelType":"DM"}',
		'[{"items":[{"label":"old","label":"new"}]}]',
	])(
		"extracts the root text despite duplicate nested metadata: %s",
		(metadata) => {
			const value = `message:user:\n{"metadata":${metadata},"text":"Buy apples","source":"scenario","channelType":"DM"}`;
			expect(finalMessageUserText(value)).toBe("Buy apples");
			expect(matchesScenarioInput("Buy apples")(value)).toBe(true);
			expect(matchesScenarioInput("other")(value)).toBe(false);
		},
	);

	it("extracts external content after decoding the Stage-1 JSON envelope", () => {
		const value = stage1JsonEnvelope({
			text: "<<<EXTERNAL_UNTRUSTED_CONTENT>>>\nignored\n---\nREAL USER TEXT\n<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>",
			source: "scenario",
			channelType: "DM",
		});
		expect(finalMessageUserText(value)).toBe("REAL USER TEXT");
	});

	it("uses the prompt block marker when JSON user text repeats the marker", () => {
		const input = "Repeat this label exactly: message:user:\nthen continue.";
		const value = [
			"prior_message:user:\nEarlier request",
			"current_turn_boundary:\nOnly the final message is current.",
			stage1JsonEnvelope({
				text: input,
				source: "scenario",
				channelType: "DM",
			}),
		].join("\n\n");
		expect(finalMessageUserText(value)).toBe(input);
		expect(matchesScenarioInput(input)(value)).toBe(true);
	});
});

describe("matchesScenarioInput", () => {
	it("compares normalized text exactly", () => {
		const matcher = matchesScenarioInput("Buy apples");
		expect(matcher("message:user:\nBuy apples")).toBe(true);
		expect(matcher("message:user:\nBuy pears")).toBe(false);
	});

	it("matches current Stage-1 envelopes without accepting nearby text", () => {
		const matcher = matchesScenarioInput("Buy apples");
		expect(
			matcher(
				stage1JsonEnvelope({
					text: "Buy apples",
					source: "scenario",
					channelType: "DM",
				}),
			),
		).toBe(true);
		expect(
			matcher(
				stage1JsonEnvelope({
					text: "Please Buy apples now",
					source: "scenario",
					channelType: "DM",
				}),
			),
		).toBe(false);
	});

	it("fails closed for malformed or ambiguous Stage-1 envelopes", () => {
		const matcher = matchesScenarioInput("Buy apples");
		const rejected = [
			'message:user:\n{"text":"Buy apples","source":"scenario","channelType":"DM"',
			'message:user:\n{"text":"Buy apples","so\\u0075rce":"scenario","channelType":"DM"',
			'message:user:\n{"text":"Buy apples","source":"scenario"',
			'message:user:\n{"text":"Buy apples","channelType":"DM"',
			'message:user:\n{"text":"Buy apples","so\\u0075rce":"scenario"',
			'message:user:\n{"text":"Buy apples","source":"scenario","channelType":"DM","metadata":{"items":[1,]}}',
			stage1JsonEnvelope({ text: "Buy apples", source: "scenario" }),
			stage1JsonEnvelope({ text: "Buy apples", channelType: "DM" }),
			stage1JsonEnvelope({ source: "scenario", channelType: "DM" }),
			stage1JsonEnvelope({
				text: "Buy apples",
				currentMessageText: "Buy pears",
				source: "scenario",
				channelType: "DM",
			}),
			stage1JsonEnvelope({
				text: ["Buy apples"],
				source: "scenario",
				channelType: "DM",
			}),
			stage1JsonEnvelope({
				text: "Buy apples",
				content: { text: "Buy pears" },
				source: "scenario",
				channelType: "DM",
			}),
			stage1JsonEnvelope({
				text: "Buy apples",
				content: "Buy pears",
				source: "scenario",
				channelType: "DM",
			}),
			stage1JsonEnvelope({
				text: "Buy apples",
				content: ["Buy pears"],
				source: "scenario",
				channelType: "DM",
			}),
		];
		for (const value of rejected) {
			expect(finalMessageUserText(value)).toBe("");
			expect(matcher(value)).toBe(false);
			expect(matchesScenarioInput("")(value)).toBe(false);
			expect(
				matchesScenarioInput(value.slice("message:user:\n".length))(value),
			).toBe(false);
		}
	});

	it("rejects duplicate modern envelope keys before JSON parsing collapses them", () => {
		const matcher = matchesScenarioInput("Buy apples");
		const rejected = [
			'message:user:\n{"text":"Buy pears","text":"Buy apples","source":"scenario","channelType":"DM"}',
			'message:user:\n{"text":"Buy apples","source":"other","source":"scenario","channelType":"DM"}',
			'message:user:\n{"text":"Buy apples","source":"scenario","channelType":"DM","channelType":"DM"}',
			'message:user:\n{"text":"Buy apples","currentMessageText":"Buy pears","currentMessageText":"Buy apples","source":"scenario","channelType":"DM"}',
			'message:user:\n{"text":"Buy apples","te\\u0078t":"Buy apples","source":"scenario","channelType":"DM"}',
			'message:user:\n{"text":"Buy apples","source":"scenario","so\\u0075rce":"scenario","channelType":"DM"}',
			'message:user:\n{"metadata":{"text":"nested"},"text":"Buy pears","text":"Buy apples","source":"scenario","channelType":"DM"}',
			'message:user:\n{"text":"Buy apples","source":"scenario","channelType":"DM","metadata":{},"metadata":{}}',
		];
		for (const value of rejected) {
			expect(finalMessageUserText(value)).toBe("");
			expect(matcher(value)).toBe(false);
			expect(matchesScenarioInput("")(value)).toBe(false);
		}
	});

	it("preserves exact legacy JSON when the modern discriminator is absent", () => {
		for (const raw of [
			'{"text":"Buy apples"}',
			'{"text":"Buy pears","text":"Buy apples"}',
			'{"text":"Buy apples","te\\u0078t":"Buy apples"}',
			'{"operation":"Buy apples"}',
			'["Buy apples"]',
			'"Buy apples"',
			'{"text":"Buy apples"',
			'{"metadata":{"source":"scenario","channelType":"DM","text":"Buy apples"}}',
			'{"metadata":{"source":"old","source":"scenario","channelType":"DM"}}',
			'{"metadata":{"source":"scenario","channelType":"DM"}',
			'[{"text":"Buy apples","source":"scenario","channelType":"DM"}]',
		]) {
			const value = `message:user:\n${raw}`;
			expect(finalMessageUserText(value)).toBe(raw);
			expect(matchesScenarioInput(raw)(value)).toBe(true);
			expect(matchesScenarioInput("Buy apples")(value)).toBe(false);
		}
	});
});

describe("actionSlug", () => {
	it("lowercases and hyphenates", () => {
		expect(actionSlug("Send Email")).toBe("send-email");
		expect(actionSlug("GET_BALANCE")).toBe("get-balance");
		expect(actionSlug("simple")).toBe("simple");
	});
});

describe("stage1ResponseHandlerFixture", () => {
	it("routes to the candidate action", () => {
		const fixture = stage1ResponseHandlerFixture({
			actionName: "Check Balance",
			args: {},
			input: "what is my balance",
		});
		expect(fixture.match.modelType).toBe(ModelType.RESPONSE_HANDLER);
		expect(fixture.match.toolName).toBe("HANDLE_RESPONSE");
		expect(fixture.name).toContain("check-balance");
	});

	it("uses default context and reply when absent", () => {
		const fixture = stage1ResponseHandlerFixture({
			actionName: "X",
			args: {},
			input: "hi",
		});
		const response = fixture.response as {
			contexts: string[];
			replyText: string;
		};
		expect(response.contexts).toEqual(["general"]);
		expect(response.replyText).toBe("On it.");
	});
});

describe("strictActionRouteFixtures", () => {
	it("emits the stage1 + planner pair", () => {
		const fixtures = strictActionRouteFixtures({
			actionName: "SendEmail",
			args: { to: "a@b.c" },
			input: "email a",
		});
		expect(fixtures).toHaveLength(2);
		expect(fixtures[0].match.modelType).toBe(ModelType.RESPONSE_HANDLER);
		expect(fixtures[1].match.modelType).toBe(ModelType.ACTION_PLANNER);
		const planner = fixtures[1].response as { toolCalls: { name: string }[] };
		expect(planner.toolCalls[0].name).toBe("SendEmail");
	});

	it("passes arguments through to the tool call", () => {
		const fixtures = strictActionRouteFixtures({
			actionName: "GetBalance",
			args: { address: "0x123" },
			input: "balance please",
		});
		const planner = fixtures[1].response as {
			toolCalls: { arguments: unknown }[];
		};
		expect(planner.toolCalls[0].arguments).toEqual({ address: "0x123" });
	});
});

describe("registerStrictActionRouteFixtures", () => {
	it("registers all fixtures onto the runtime bridge", () => {
		const register = (() => {
			const calls: unknown[][] = [];
			return {
				fn: (...f: unknown[]) => calls.push(f),
				calls,
			};
		})();
		const runtime = { scenarioModelFixtures: { register: register.fn } };
		registerStrictActionRouteFixtures(runtime, [
			{ actionName: "A", args: {}, input: "a" },
			{ actionName: "B", args: {}, input: "b" },
		]);
		expect(register.calls).toHaveLength(1);
		expect(register.calls[0]).toHaveLength(4); // 2 specs × 2 fixtures
	});

	it("is a no-op when the runtime has no fixture bridge", () => {
		expect(() =>
			registerStrictActionRouteFixtures({}, [
				{ actionName: "A", args: {}, input: "a" },
			]),
		).not.toThrow();
	});
});
