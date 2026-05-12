import { describe, expect, it } from "vitest";
import commandsPlugin from "../src/index";

describe("commands plugin action surface", () => {
	it("registers no actions; slash-command parsing is handled by the message handler", () => {
		expect(commandsPlugin.actions ?? []).toEqual([]);
	});
});
