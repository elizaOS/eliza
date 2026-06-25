import { afterEach, describe, expect, it } from "vitest";
import { captureModelLookupCaller } from "./model-lookup-caller.js";

function probeLookupCaller(): ReturnType<typeof captureModelLookupCaller> {
	return captureModelLookupCaller();
}

function nestedLookupCaller(): ReturnType<typeof captureModelLookupCaller> {
	return probeLookupCaller();
}

describe("captureModelLookupCaller", () => {
	const previousLogLevel = process.env.LOG_LEVEL;

	afterEach(() => {
		if (previousLogLevel === undefined) {
			delete process.env.LOG_LEVEL;
		} else {
			process.env.LOG_LEVEL = previousLogLevel;
		}
	});

	it("returns undefined when LOG_LEVEL is above debug", () => {
		process.env.LOG_LEVEL = "info";
		expect(probeLookupCaller()).toBeUndefined();
	});

	it("returns package names only at debug log level", () => {
		process.env.LOG_LEVEL = "debug";
		const trace = nestedLookupCaller();
		expect(trace).toBeDefined();
		expect(trace?.caller).toBe("core");
		expect(trace?.callerStack).toEqual(["core"]);
		expect(trace?.callerStack.every((entry) => !entry.includes("/"))).toBe(
			true,
		);
	});
});
