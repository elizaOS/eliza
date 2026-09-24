/** Preserve tooling exclusions for source and installed script artifacts. */
import { describe, expect, it } from "vitest";
import { isSelfEditPathDenied } from "./self-edit";

describe("self-edit tooling paths", () => {
	it.each([
		"/workspace/packages/app/scripts/run-node.ts",
		"/workspace/packages/app/scripts/run-node.mjs",
		"/consumer/node_modules/@elizaos/app/dist/scripts/run-node.mjs",
		"C:\\consumer\\node_modules\\@elizaos\\app\\dist\\scripts\\run-node.mjs",
	])("protects %s", (file) => {
		expect(isSelfEditPathDenied(file)).toBe(true);
	});
	it("allows ordinary source edits", () => {
		expect(isSelfEditPathDenied("/workspace/src/run-node-example.ts")).toBe(
			false,
		);
	});
});
