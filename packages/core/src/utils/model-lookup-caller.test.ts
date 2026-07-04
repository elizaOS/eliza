/**
 * Tests for `captureModelLookupCaller` / `captureModelLookupCallerFromStack`,
 * covering plugin/package attribution across live stacks, installed
 * `node_modules` and pnpm virtual-store layouts, and rejection of third-party
 * frames.
 */
import { describe, expect, it } from "vitest";
import {
	captureModelLookupCaller,
	captureModelLookupCallerFromStack,
} from "./model-lookup-caller.js";

function probeLookupCaller(): ReturnType<typeof captureModelLookupCaller> {
	return captureModelLookupCaller();
}

function nestedLookupCaller(): ReturnType<typeof captureModelLookupCaller> {
	return probeLookupCaller();
}

describe("captureModelLookupCaller", () => {
	it("returns package names when capturing the current stack", () => {
		const trace = nestedLookupCaller();
		expect(trace).toBeDefined();
		expect(trace?.caller).toBe("core");
		expect(trace?.callerStack).toEqual(["core"]);
		expect(trace?.callerStack.every((entry) => !entry.includes("/"))).toBe(
			true,
		);
	});

	it("keeps installed elizaOS package attribution under node_modules", () => {
		const stack = [
			"Error: model lookup",
			"    at captureModelLookupCaller (/app/node_modules/@elizaos/core/dist/utils/model-lookup-caller.js:70:12)",
			"    at AgentRuntime.useModel (/app/node_modules/@elizaos/core/dist/runtime.js:4644:24)",
			"    at textHandler (/app/node_modules/@elizaos/plugin-openai/dist/models/text.js:42:18)",
		].join("\n");

		expect(captureModelLookupCallerFromStack(stack)).toEqual({
			caller: "plugin-openai",
			callerStack: ["plugin-openai"],
		});
	});

	it("keeps installed elizaOS package attribution under pnpm virtual store paths", () => {
		const stack = [
			"Error: model lookup",
			"    at captureModelLookupCaller (/app/node_modules/.pnpm/@elizaos+core@1.5.0/node_modules/@elizaos/core/dist/utils/model-lookup-caller.js:70:12)",
			"    at AgentRuntime.useModel (/app/node_modules/.pnpm/@elizaos+core@1.5.0/node_modules/@elizaos/core/dist/runtime.js:4644:24)",
			"    at route (/app/node_modules/.pnpm/@elizaos+plugin-groq@1.5.0/node_modules/@elizaos/plugin-groq/dist/models/text.js:28:11)",
		].join("\n");

		expect(captureModelLookupCallerFromStack(stack)).toEqual({
			caller: "plugin-groq",
			callerStack: ["plugin-groq"],
		});
	});

	it("continues to ignore third-party node_modules frames", () => {
		const stack = [
			"Error: model lookup",
			"    at captureModelLookupCaller (/app/node_modules/@elizaos/core/dist/utils/model-lookup-caller.js:70:12)",
			"    at AgentRuntime.useModel (/app/node_modules/@elizaos/core/dist/runtime.js:4644:24)",
			"    at callProvider (/app/node_modules/some-sdk/dist/index.js:11:9)",
		].join("\n");

		expect(captureModelLookupCallerFromStack(stack)).toBeUndefined();
	});
});
