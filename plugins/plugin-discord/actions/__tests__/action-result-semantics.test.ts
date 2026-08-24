import { describe, expect, it } from "vitest";
import {
	terminalActionInteractionSemantics,
	terminalActionResultData,
} from "./actionResultSemantics.ts";

describe("terminalActionResultData", () => {
	it("sets suppression flags on empty data", () => {
		const data = terminalActionResultData();
		expect(data.suppressVisibleCallback).toBe(true);
		expect(data.suppressActionResultClipboard).toBe(true);
	});

	it("preserves existing fields", () => {
		const data = terminalActionResultData({ text: "done" } as never);
		expect(data.text).toBe("done");
		expect(data.suppressVisibleCallback).toBe(true);
	});
});

describe("terminalActionInteractionSemantics", () => {
	it("suppresses post-action continuation", () => {
		expect(
			terminalActionInteractionSemantics.suppressPostActionContinuation,
		).toBe(true);
		expect(
			terminalActionInteractionSemantics.suppressActionResultClipboard,
		).toBe(true);
	});
});
