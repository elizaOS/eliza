import { describe, expect, it } from "vitest";
import {
	activeServerKindToFirstRunRuntimeTarget,
	isElizaCloudFirstRunTarget,
} from "./runtime-target.ts";

describe("isElizaCloudFirstRunTarget", () => {
	it("accepts the two elizacloud variants", () => {
		expect(isElizaCloudFirstRunTarget("elizacloud")).toBe(true);
		expect(isElizaCloudFirstRunTarget("elizacloud-hybrid")).toBe(true);
	});

	it("rejects local/remote/empty", () => {
		expect(isElizaCloudFirstRunTarget("local")).toBe(false);
		expect(isElizaCloudFirstRunTarget("remote")).toBe(false);
		expect(isElizaCloudFirstRunTarget("")).toBe(false);
	});
});

describe("activeServerKindToFirstRunRuntimeTarget", () => {
	it("maps server kinds onto persisted targets", () => {
		expect(activeServerKindToFirstRunRuntimeTarget("local")).toBe("local");
		expect(activeServerKindToFirstRunRuntimeTarget("cloud")).toBe("elizacloud");
		expect(activeServerKindToFirstRunRuntimeTarget("remote")).toBe("remote");
	});
});
