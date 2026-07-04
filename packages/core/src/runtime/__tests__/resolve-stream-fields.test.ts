/**
 * Locks the default token-stream contract for #9174: the line-oriented
 * dynamic-prompt path streams the clean reply `text` by default, honours
 * explicit `streamField` opt-in/opt-out, and never streams control fields.
 */
import { describe, expect, it } from "vitest";
import { resolveDynamicPromptStreamFields } from "../../runtime";
import type { SchemaRow } from "../../types/state";

describe("resolveDynamicPromptStreamFields (#9174)", () => {
	it("streams the `text` field by default when no preference is expressed", () => {
		const schema: SchemaRow[] = [
			{ field: "thought", description: "internal reasoning" },
			{ field: "text", description: "user-facing reply" },
			{ field: "actions", description: "actions", type: "array" },
		];
		expect(resolveDynamicPromptStreamFields(schema)).toEqual(["text"]);
	});

	it("does not stream control fields (thought/actions) by default", () => {
		const schema: SchemaRow[] = [
			{ field: "thought", description: "internal reasoning" },
			{ field: "actions", description: "actions", type: "array" },
		];
		expect(resolveDynamicPromptStreamFields(schema)).toEqual([]);
	});

	it("includes any field that opts in with streamField: true", () => {
		const schema: SchemaRow[] = [
			{ field: "thought", description: "internal reasoning" },
			{ field: "text", description: "reply" },
			{
				field: "summary",
				description: "a streamed summary",
				streamField: true,
			},
		];
		expect(resolveDynamicPromptStreamFields(schema)).toEqual([
			"text",
			"summary",
		]);
	});

	it("excludes a default field that opts out with streamField: false", () => {
		const schema: SchemaRow[] = [
			{ field: "text", description: "reply", streamField: false },
		];
		expect(resolveDynamicPromptStreamFields(schema)).toEqual([]);
	});

	it("preserves document order of streamed fields", () => {
		const schema: SchemaRow[] = [
			{ field: "a", description: "", streamField: true },
			{ field: "text", description: "" },
			{ field: "b", description: "", streamField: true },
		];
		expect(resolveDynamicPromptStreamFields(schema)).toEqual([
			"a",
			"text",
			"b",
		]);
	});
});
