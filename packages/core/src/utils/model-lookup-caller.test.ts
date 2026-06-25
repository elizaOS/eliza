import { afterEach, describe, expect, it } from "vitest";
import { captureModelLookupCaller } from "./model-lookup-caller.js";

function probeLookupCaller(
	logLevel: string | undefined,
): ReturnType<typeof captureModelLookupCaller> {
	return captureModelLookupCaller(logLevel);
}

function nestedLookupCaller(
	logLevel: string | undefined,
): ReturnType<typeof captureModelLookupCaller> {
	return probeLookupCaller(logLevel);
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

	it("returns undefined when the runtime log level is above debug", () => {
		process.env.LOG_LEVEL = "debug";
		expect(probeLookupCaller("info")).toBeUndefined();
	});

	it("returns package names when the runtime log level is debug", () => {
		delete process.env.LOG_LEVEL;
		const trace = nestedLookupCaller("debug");
		expect(trace).toBeDefined();
		expect(trace?.caller).toBe("core");
		expect(trace?.callerStack).toEqual(["core"]);
		expect(trace?.callerStack.every((entry) => !entry.includes("/"))).toBe(
			true,
		);
	});
});
