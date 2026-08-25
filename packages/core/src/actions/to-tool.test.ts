/**
 * Unit tests for action to native LLM tool definition translation.
 */

import { describe, expect, it } from "vitest";
import type { Action } from "../types/index.js";
import {
	actionToTool,
	assertNativeToolName,
	buildPlannerToolsFromActions,
	buildPlannerToolsFromTieredActions,
	CORE_PLANNER_TERMINALS,
	createHandleResponseTool,
	HANDLE_RESPONSE_TOOL,
	HANDLE_RESPONSE_TOOL_NAME,
} from "./to-tool.js";

describe("to-tool", () => {
	it("validates native tool name format", () => {
		expect(() => assertNativeToolName("SEND_MESSAGE")).not.toThrow();
		expect(() => assertNativeToolName("REPLY")).not.toThrow();
		expect(() => assertNativeToolName("ACTION_123_ABC")).not.toThrow();

		expect(() => assertNativeToolName("invalid-tool-name")).toThrowError(
			/Invalid tool name/,
		);
		expect(() => assertNativeToolName("send message")).toThrowError(
			/Invalid tool name/,
		);
		expect(() => assertNativeToolName("123_ACTION")).toThrowError(
			/Invalid tool name/,
		);
	});

	it("builds HANDLE_RESPONSE tool definition for standard and direct-message modes", () => {
		expect(HANDLE_RESPONSE_TOOL.name).toBe(HANDLE_RESPONSE_TOOL_NAME);
		expect(HANDLE_RESPONSE_TOOL.type).toBe("function");
		expect(HANDLE_RESPONSE_TOOL.strict).toBe(true);

		const dmTool = createHandleResponseTool({ directMessage: true });
		expect(dmTool.description).toContain("direct-message");
	});

	it("converts Action to PlannerToolDefinition with JSON Schema parameters", () => {
		const action: Action = {
			name: "CALCULATE_SUM",
			description: "Adds two numbers together.",
			parameters: [
				{
					name: "a",
					description: "First number",
					required: true,
					schema: { type: "number" },
				},
				{
					name: "b",
					description: "Second number",
					required: true,
					schema: { type: "number" },
				},
			],
			handler: async () => undefined,
			validate: async () => true,
			examples: [],
		};

		const tool = actionToTool(action);
		expect(tool.type).toBe("function");
		expect(tool.function.name).toBe("CALCULATE_SUM");
		expect(tool.function.description).toBe("Adds two numbers together.");
		expect(tool.function.strict).toBe(true);
		expect(tool.function.parameters.type).toBe("object");
	});

	it("builds flat planner tools and embeds routing hint when present", () => {
		const action1 = {
			name: "SEARCH_WEB",
			description: "Search web queries.",
			routingHint: "Use for real-time web lookups.",
			parameters: [],
		};
		const action2 = {
			name: "READ_FILE",
			description: "Read local file contents.",
			parameters: [],
		};

		const tools = buildPlannerToolsFromActions([action1, action2]);
		expect(tools).toHaveLength(2);
		expect(tools[0].name).toBe("SEARCH_WEB");
		expect(tools[0].description).toBe(
			"Use for real-time web lookups.\nSearch web queries.",
		);
		expect(tools[1].name).toBe("READ_FILE");
		expect(tools[1].description).toBe("Read local file contents.");
	});

	it("expands sub-actions and deduplicates in tiered planner tool builder", () => {
		const childAction = {
			name: "FETCH_WEATHER",
			description: "Fetch weather data.",
			parameters: [],
		};
		const parentAction = {
			name: "WEATHER_SUITE",
			description: "Parent weather actions.",
			parameters: [],
			subActions: ["FETCH_WEATHER"],
		};

		const tools = buildPlannerToolsFromTieredActions(
			[parentAction, childAction],
			{
				actionLookup: new Map([["FETCH_WEATHER", childAction]]),
			},
		);

		// Weather suite parent followed by expanded child, deduplicated
		expect(tools.map((t) => t.name)).toEqual([
			"WEATHER_SUITE",
			"FETCH_WEATHER",
		]);
	});

	it("exposes core planner terminal tools", () => {
		expect(CORE_PLANNER_TERMINALS.map((t) => t.name)).toEqual([
			"REPLY",
			"IGNORE",
			"STOP",
		]);
	});
});
