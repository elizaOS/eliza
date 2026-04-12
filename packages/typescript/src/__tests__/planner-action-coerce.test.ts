import { describe, expect, test } from "bun:test";
import type { IAgentRuntime, Memory, UUID } from "../types";
import {
	coercePlannerActionTokenList,
	parseActionBlocksFromXml,
	salvagePlannerContentFromStructuredFailure,
	shouldApplyReflectionTaskContinuation,
} from "../services/message";

function mockRuntime(): IAgentRuntime {
	return {
		logger: { warn: () => {} },
		isActionPlanningEnabled: () => true,
	} as unknown as IAgentRuntime;
}

describe("parseActionBlocksFromXml", () => {
	test("parses <name>REPLY</name> with inner params", () => {
		const xml = `<action><name>REPLY</name><params><text>Hello</text></params></action>`;
		const entries = parseActionBlocksFromXml(xml);
		expect(entries).toEqual([
			{ name: "REPLY", paramsXml: "<text>Hello</text>" },
		]);
	});

	test("parses bare REPLY with trailing params block", () => {
		const xml = `<action>REPLY</action>
   <params>
      <text>Great progress!</text>
    </params>`;
		const entries = parseActionBlocksFromXml(xml);
		expect(entries).toEqual([
			{ name: "REPLY", paramsXml: "<text>Great progress!</text>" },
		]);
	});

	test("parses lowercase reply token in action body", () => {
		const xml = `<action>reply</action><params><text>Hi</text></params>`;
		const entries = parseActionBlocksFromXml(xml);
		expect(entries).toEqual([{ name: "REPLY", paramsXml: "<text>Hi</text>" }]);
	});
});

describe("coercePlannerActionTokenList", () => {
	test("strips bracketed STOP and expands reply blob", () => {
		const parsedXml: Record<string, unknown> = { text: "" };
		const out = coercePlannerActionTokenList(
			["[STOP]", "<reply>Done.</reply>"],
			parsedXml,
			mockRuntime(),
		);
		expect(out).toEqual(["STOP", "REPLY"]);
		expect(parsedXml.text).toBe("Done.");
	});

	test("reply blob wins over conflicting top-level text", () => {
		const parsedXml: Record<string, unknown> = {
			text: "Opening line the model put in text field.",
		};
		const out = coercePlannerActionTokenList(
			["<reply>Actual reply body.</reply>"],
			parsedXml,
			mockRuntime(),
		);
		expect(out).toEqual(["REPLY"]);
		expect(parsedXml.text).toBe("Actual reply body.");
	});

	test("coerces single malformed array entry with action+params", () => {
		const parsedXml: Record<string, unknown> = {};
		const blob = `<action>REPLY</action>
   <params>
      <text>Body here.</text>
    </params>`;
		const out = coercePlannerActionTokenList([blob], parsedXml, mockRuntime());
		expect(out).toEqual(["REPLY"]);
		expect(parsedXml.params).toContain("REPLY");
		expect(parsedXml.params).toContain("<text>Body here.</text>");
		expect(parsedXml.text).toBe("Body here.");
	});

	test("dedupes consecutive identical actions", () => {
		const parsedXml: Record<string, unknown> = {};
		const out = coercePlannerActionTokenList(
			["REPLY", "REPLY"],
			parsedXml,
			mockRuntime(),
		);
		expect(out).toEqual(["REPLY"]);
	});

	test("salvages <text> from malformed action XML when full parse fails", () => {
		const parsedXml: Record<string, unknown> = { text: "" };
		const junk = `<action><oops>broken</oops><text>Recovered body.</text>`;
		const out = coercePlannerActionTokenList([junk], parsedXml, mockRuntime());
		expect(out).toEqual(["REPLY"]);
		expect(parsedXml.text).toBe("Recovered body.");
	});

	test("prefers longer REPLY params text when it extends top-level text (no duplicate prefix)", () => {
		const parsedXml: Record<string, unknown> = { text: "Hello" };
		const blob = `<action>REPLY</action><params><text>Hello world</text></params>`;
		const out = coercePlannerActionTokenList([blob], parsedXml, mockRuntime());
		expect(out).toEqual(["REPLY"]);
		expect(parsedXml.text).toBe("Hello world");
	});

	test("prefers REPLY params text when it conflicts with top-level text (no concat)", () => {
		const parsedXml: Record<string, unknown> = {
			text: "Your effort is paying off. Let's tackle this together.",
		};
		const blob = `<action>REPLY</action><params><text>I understand feeling overwhelmed—keep going.</text></params>`;
		const out = coercePlannerActionTokenList([blob], parsedXml, mockRuntime());
		expect(out).toEqual(["REPLY"]);
		expect(parsedXml.text).toBe(
			"I understand feeling overwhelmed—keep going.",
		);
	});
});

describe("salvagePlannerContentFromStructuredFailure", () => {
	test("recovers longest <text> from broken response wrapper", () => {
		const preview = `preamble junk
<response><thought>ok</thought>
<actions><action><oops/></action></actions>
<text>User-visible reply.</text>
</response> trailing`;
		const out = salvagePlannerContentFromStructuredFailure(
			{
				source: "dynamicPromptExecFromState",
				kind: "parse_problem",
				model: "test",
				format: "XML",
				schemaFields: ["thought", "actions", "text"],
				attempts: 3,
				maxRetries: 2,
				timestamp: Date.now(),
				responsePreview: preview,
			},
			mockRuntime(),
		);
		expect(out).not.toBeNull();
		expect(out?.text).toBe("User-visible reply.");
		expect(out?.thought).toBe("ok");
		expect(out?.actions?.[0]).toBe("REPLY");
	});

	test("recovers REPLY body from action params when actions XML is present", () => {
		const preview = `<response>
<actions><action>REPLY</action>
<params><text>From params.</text></params>
</actions></response>`;
		const out = salvagePlannerContentFromStructuredFailure(
			{
				source: "dynamicPromptExecFromState",
				kind: "validation_error",
				model: "test",
				format: "XML",
				schemaFields: ["text"],
				attempts: 2,
				maxRetries: 2,
				timestamp: Date.now(),
				responsePreview: preview,
			},
			mockRuntime(),
		);
		expect(out).not.toBeNull();
		expect(out?.text).toBe("From params.");
		expect(out?.actions?.[0]).toBe("REPLY");
	});

	test("returns null when preview has no usable text or actions", () => {
		expect(
			salvagePlannerContentFromStructuredFailure(
				{
					source: "dynamicPromptExecFromState",
					kind: "parse_problem",
					model: "test",
					format: "XML",
					schemaFields: ["text"],
					attempts: 1,
					maxRetries: 0,
					timestamp: Date.now(),
					responsePreview: "<response></response>",
				},
				mockRuntime(),
			),
		).toBeNull();
	});

	test("salvages plain prose inside first <response> when <text> is absent", () => {
		const preview = `<response>
You're doing great with debugging and testing! Keep refining your approach based on what you discover.
</response>
<simple>true</simple>
</response>`;
		const out = salvagePlannerContentFromStructuredFailure(
			{
				source: "dynamicPromptExecFromState",
				kind: "parse_problem",
				model: "test",
				format: "XML",
				schemaFields: ["thought", "actions", "text", "simple"],
				attempts: 1,
				maxRetries: 2,
				timestamp: Date.now(),
				responsePreview: preview,
			},
			mockRuntime(),
		);
		expect(out).not.toBeNull();
		expect(out?.text).toContain("You're doing great with debugging");
		expect(out?.actions?.[0]).toBe("REPLY");
	});
});

describe("shouldApplyReflectionTaskContinuation", () => {
	const msg = { id: "m1" as UUID } as Memory;

	test("returns false for simple mode with no action results on message", () => {
		const rt = {
			getActionResults: () => [],
		} as unknown as IAgentRuntime;
		expect(shouldApplyReflectionTaskContinuation(rt, msg, "simple")).toBe(
			false,
		);
	});

	test("returns true for simple mode when action results exist", () => {
		const rt = {
			getActionResults: () => [{ success: true }],
		} as unknown as IAgentRuntime;
		expect(shouldApplyReflectionTaskContinuation(rt, msg, "simple")).toBe(true);
	});

	test("returns true for actions mode even with no action results", () => {
		const rt = {
			getActionResults: () => [],
		} as unknown as IAgentRuntime;
		expect(shouldApplyReflectionTaskContinuation(rt, msg, "actions")).toBe(
			true,
		);
	});
});
