import { describe, expect, it } from "vitest";
import commandsPlugin from "../src/index";

describe("commands plugin action surface", () => {
	it("registers the slash-command router instead of per-command read actions", () => {
		expect(commandsPlugin.actions?.map((action) => action.name)).toEqual([
			"COMMAND",
		]);
		expect(
			commandsPlugin.actions?.[0]?.parameters?.map((param) => param.name),
		).toEqual(["op"]);
	});
});
