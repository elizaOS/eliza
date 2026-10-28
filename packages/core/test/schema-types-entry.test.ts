import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import type * as Root from "../src/index";
import type * as Leaf from "../src/schema-types";

const LEAF_FILES = [
	"../src/schema-types.ts",
	"../src/types/json.ts",
	"../src/types/schema.ts",
	"../src/types/view-capability.ts",
];

describe("@elizaos/core/schema-types", () => {
	it("is the same declaration the root barrel exports", () => {
		expectTypeOf<Leaf.ActionParameterSchema>().toEqualTypeOf<Root.ActionParameterSchema>();
		expectTypeOf<Leaf.JSONSchema>().toEqualTypeOf<Root.JSONSchema>();
		expectTypeOf<Leaf.JsonValue>().toEqualTypeOf<Root.JsonValue>();
		expectTypeOf<Leaf.JsonObject>().toEqualTypeOf<Root.JsonObject>();
		expectTypeOf<Leaf.JsonPrimitive>().toEqualTypeOf<Root.JsonPrimitive>();
		expectTypeOf<Leaf.ViewCapability>().toEqualTypeOf<Root.ViewCapability>();
		expectTypeOf<Leaf.ViewCapabilityParameter>().toEqualTypeOf<Root.ViewCapabilityParameter>();
	});

	it("stays a type-only leaf that loads no other core module", () => {
		const allowed = new Set([
			"./types/json.ts",
			"./types/schema.ts",
			"./types/view-capability.ts",
			"./json",
		]);
		for (const file of LEAF_FILES) {
			const source = readFileSync(new URL(file, import.meta.url), "utf8");
			const specifiers = [
				...source.matchAll(
					/^(import|export)\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gms,
				),
			];
			for (const [, , typeOnly, specifier] of specifiers) {
				expect(typeOnly, `${file} -> ${specifier}`).toBeTruthy();
				expect(allowed.has(specifier), `${file} -> ${specifier}`).toBe(true);
			}
			expect(source).not.toMatch(
				/^export\s+(const|function|class|enum|let)\b/m,
			);
		}
	});
});
