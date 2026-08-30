/**
 * Deterministic unit coverage for the schema-structure and annotation-boundary
 * walks in well-formed.ts. These two exported functions have different depth
 * accounting from deepToWellFormedUnicode:
 *
 *   - wellFormedUnicodeSchemaStructure follows JSON-schema keywords
 *     (properties/$defs/anyOf/etc.) using Cerebras-normalizer accounting: a map
 *     keyword's container and an array wrapper consume no level; their member
 *     schemas get depth + 1 directly. Annotation data (default/examples/const/x-*)
 *     is carried by reference and never observed.
 *
 *   - assertSchemaAnnotationsSerializable is the wire-boundary check for
 *     annotation data: fully bounded, uniform depth charging (every edge costs
 *     one unit, no name-based exemptions), cycles fail closed on path-local
 *     ancestry, and accessor policing is annotation-scoped.
 */

import { describe, expect, it } from "vitest";
import { ElizaError } from "../errors.ts";
import {
	assertSchemaAnnotationsSerializable,
	deepToWellFormedUnicode,
	MAX_WELL_FORMED_DEPTH,
	wellFormedUnicodeSchemaStructure,
} from "./well-formed";

const LONE_SURROGATE_ESCAPE = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/;

function isWellFormed(text: string): boolean {
	return (text as unknown as { isWellFormed: () => boolean }).isWellFormed();
}

describe("wellFormedUnicodeSchemaStructure", () => {
	it("sanitizes a lone surrogate in a schema string value", () => {
		const schema = { type: "string", description: "bad\uD83Dvalue" };
		const result = wellFormedUnicodeSchemaStructure(schema);
		expect(result.description).toBe("bad�value");
		expect(isWellFormed(result.description as string)).toBe(true);
	});

	it("returns the same reference when nothing needs sanitizing", () => {
		const schema = { type: "string", description: "clean 💀 value" };
		expect(wellFormedUnicodeSchemaStructure(schema)).toBe(schema);
	});

	it("follows properties keyword and sanitizes nested schema strings", () => {
		const schema = {
			type: "object",
			properties: {
				name: { type: "string", description: "bad\uD83Dname" },
				age: { type: "integer", description: "clean" },
			},
		};
		const result = wellFormedUnicodeSchemaStructure(schema);
		expect(result.properties.name.description).toBe("bad�name");
		expect(result.properties.age.description).toBe("clean");
	});

	it("follows $defs keyword and sanitizes nested schema strings", () => {
		const schema = {
			$defs: {
				Emotion: {
					type: "string",
					description: "bad\uD83Demotion",
				},
			},
		};
		const result = wellFormedUnicodeSchemaStructure(schema);
		expect(result.$defs.Emotion.description).toBe("bad�emotion");
	});

	it("follows anyOf/oneOf/allOf array wrappers", () => {
		const schema = {
			anyOf: [
				{ type: "string", description: "bad\uD83Da" },
				{ type: "integer", description: "bad\uD83Db" },
			],
		};
		const result = wellFormedUnicodeSchemaStructure(schema);
		expect(result.anyOf[0].description).toBe("bad�a");
		expect(result.anyOf[1].description).toBe("bad�b");
	});

	it("follows items keyword for array-typed schemas", () => {
		const schema = {
			type: "array",
			items: { type: "string", description: "bad\uD83Ditem" },
		};
		const result = wellFormedUnicodeSchemaStructure(schema);
		expect(result.items.description).toBe("bad�item");
	});

	it("follows prefixItems keyword", () => {
		const schema = {
			prefixItems: [
				{ type: "string", description: "bad\uD83Dp" },
			],
		};
		const result = wellFormedUnicodeSchemaStructure(schema);
		expect(result.prefixItems[0].description).toBe("bad�p");
	});

	it("follows patternProperties keyword", () => {
		const schema = {
			patternProperties: {
				"^x-": { type: "string", description: "bad\uD83Dpattern" },
			},
		};
		const result = wellFormedUnicodeSchemaStructure(schema);
		expect(result.patternProperties["^x-"].description).toBe("bad�pattern");
	});

	it("follows definitions keyword", () => {
		const schema = {
			definitions: {
				Address: { type: "string", description: "bad\uD83Daddr" },
			},
		};
		const result = wellFormedUnicodeSchemaStructure(schema);
		expect(result.definitions.Address.description).toBe("bad�addr");
	});

	it("follows dependentSchemas keyword", () => {
		const schema = {
			dependentSchemas: {
				name: { type: "string", description: "bad\uD83Ddep" },
			},
		};
		const result = wellFormedUnicodeSchemaStructure(schema);
		expect(result.dependentSchemas.name.description).toBe("bad�dep");
	});

	it("follows dependencies keyword", () => {
		const schema = {
			dependencies: {
				credit_card: { type: "string", description: "bad\uD83Ddep" },
			},
		};
		const result = wellFormedUnicodeSchemaStructure(schema);
		expect(result.dependencies.credit_card.description).toBe("bad�dep");
	});

	it("carries annotation data (default/examples/const) by reference", () => {
		const annotationData = { nested: { bad\uD83D: "value" } };
		const schema = {
			type: "string",
			default: annotationData,
			examples: ["clean", "bad\uD83Dexample"],
			const: annotationData,
		};
		const result = wellFormedUnicodeSchemaStructure(schema);
		// Annotation data is carried by reference — NOT sanitized
		expect(result.default).toBe(annotationData);
		expect(result.examples[1]).toBe("bad\uD83Dexample");
		expect(result.const).toBe(annotationData);
	});

	it("carries x-* annotation keys by reference", () => {
		const annotationData = { bad\uD83D: "value" };
		const schema = {
			type: "string",
			"x-custom": annotationData,
		};
		const result = wellFormedUnicodeSchemaStructure(schema);
		expect(result["x-custom"]).toBe(annotationData);
	});

	it("sanitizes annotation keys that contain lone surrogates", () => {
		const schema = {
			type: "string",
			"bad\uD83Ddefault": "value",
		};
		const result = wellFormedUnicodeSchemaStructure(schema);
		// The annotation key is sanitized (changed flag set)
		expect(Object.keys(result)).toContain("bad�default");
	});

	it("does not serialize to lone surrogate escapes", () => {
		const schema = {
			type: "object",
			properties: {
				field: { type: "string", description: "bad\uD83Dfield" },
			},
		};
		const result = wellFormedUnicodeSchemaStructure(schema);
		const serialized = JSON.stringify(result);
		expect(LONE_SURROGATE_ESCAPE.test(serialized)).toBe(false);
	});

	it("preserves non-string values (numbers, booleans, null)", () => {
		const schema = {
			type: "integer",
			minLength: 1,
			maxLength: 100,
			nullable: true,
			default: null,
		};
		const result = wellFormedUnicodeSchemaStructure(schema);
		expect(result.minLength).toBe(1);
		expect(result.maxLength).toBe(100);
		expect(result.nullable).toBe(true);
		expect(result.default).toBe(null);
	});

	it("passes non-plain objects through untouched", () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const schema = { type: "string", data: bytes };
		const result = wellFormedUnicodeSchemaStructure(schema);
		expect(result.data).toBe(bytes);
	});

	it("fails closed on accessor properties", () => {
		const schema = { type: "string" };
		Object.defineProperty(schema, "bad", {
			get: () => "bad\uD83Dvalue",
			enumerable: true,
			configurable: true,
		});
		expect(() => wellFormedUnicodeSchemaStructure(schema)).toThrow(ElizaError);
	});

	it("fails closed on nesting exceeding maxDepth", () => {
		// Build a deeply nested schema that exceeds MAX_WELL_FORMED_DEPTH
		let schema: any = { type: "string", description: "leaf" };
		for (let i = 0; i < MAX_WELL_FORMED_DEPTH + 2; i++) {
			schema = { type: "object", properties: { nested: schema } };
		}
		expect(() => wellFormedUnicodeSchemaStructure(schema)).toThrow(
			ElizaError,
		);
	});

	it("respects custom maxDepth option", () => {
		const schema = {
			type: "object",
			properties: {
				nested: {
					type: "object",
					properties: {
						deep: { type: "string", description: "bad\uD83Ddeep" },
					},
				},
			},
		};
		// With maxDepth=1, the deep schema should fail
		expect(() =>
			wellFormedUnicodeSchemaStructure(schema, { maxDepth: 1 }),
		).toThrow(ElizaError);
		// With maxDepth=10, it should succeed
		const result = wellFormedUnicodeSchemaStructure(schema, {
			maxDepth: 10,
		});
		expect(result.properties.nested.properties.deep.description).toBe(
			"bad�deep",
		);
	});

	it("fails closed on cyclic structures", () => {
		const schema: any = { type: "object", properties: {} };
		schema.properties.self = schema;
		expect(() => wellFormedUnicodeSchemaStructure(schema)).toThrow(
			ElizaError,
		);
	});

	it("handles empty objects and arrays", () => {
		const schema = {
			type: "object",
			properties: {},
			anyOf: [],
		};
		const result = wellFormedUnicodeSchemaStructure(schema);
		expect(result.properties).toEqual({});
		expect(result.anyOf).toEqual([]);
	});

	it("handles sparse arrays correctly", () => {
		const schema = {
			type: "array",
			prefixItems: [{ type: "string" }, , { type: "integer" }],
		};
		const result = wellFormedUnicodeSchemaStructure(schema);
		expect(result.prefixItems.length).toBe(3);
		expect(result.prefixItems[0].type).toBe("string");
		expect(result.prefixItems[1]).toBeUndefined();
		expect(result.prefixItems[2].type).toBe("integer");
	});

	it("preserves the source prototype", () => {
		class SchemaClass {
			type = "string";
			description = "bad\uD83Dproto";
		}
		const schema = new SchemaClass();
		const result = wellFormedUnicodeSchemaStructure(schema);
		expect(Object.getPrototypeOf(result)).toBe(SchemaClass.prototype);
		expect(result.description).toBe("bad�proto");
	});

	it("applies first-write-wins for key collisions", () => {
		const schema = {
			"a\uD83Db": 1,
			"a\uDC80b": 2,
		};
		const result = wellFormedUnicodeSchemaStructure(schema);
		const keys = Object.keys(result);
		// Both sanitize to "a�b" — first one wins
		expect(keys.length).toBe(1);
		expect(keys[0]).toBe("a�b");
		expect(result["a�b"]).toBe(1);
	});

	it("sanitizes object keys containing lone surrogates", () => {
		const schema = { "bad\uD83Dkey": { type: "string" } };
		const result = wellFormedUnicodeSchemaStructure(schema);
		expect(Object.keys(result)).toContain("bad�key");
	});
});

describe("assertSchemaAnnotationsSerializable", () => {
	it("passes for a clean annotation value", () => {
		const annotation = { text: "clean 💀 value", count: 42 };
		expect(() =>
			assertSchemaAnnotationsSerializable(annotation),
		).not.toThrow();
	});

	it("passes for nested annotation objects", () => {
		const annotation = {
			nested: { deep: { value: "clean 💀" } },
		};
		expect(() =>
			assertSchemaAnnotationsSerializable(annotation),
		).not.toThrow();
	});

	it("passes for arrays in annotation data", () => {
		const annotation = { items: [1, 2, 3], nested: ["a", "b"] };
		expect(() =>
			assertSchemaAnnotationsSerializable(annotation),
		).not.toThrow();
	});

	it("passes for empty objects and arrays", () => {
		expect(() => assertSchemaAnnotationsSerializable({})).not.toThrow();
		expect(() => assertSchemaAnnotationsSerializable([])).not.toThrow();
	});

	it("passes for non-object values", () => {
		expect(() => assertSchemaAnnotationsSerializable("clean")).not.toThrow();
		expect(() => assertSchemaAnnotationsSerializable(42)).not.toThrow();
		expect(() => assertSchemaAnnotationsSerializable(null)).not.toThrow();
		expect(() =>
			assertSchemaAnnotationsSerializable(undefined),
		).not.toThrow();
		expect(() => assertSchemaAnnotationsSerializable(true)).not.toThrow();
	});

	it("fails closed on accessor properties inside annotation subtrees", () => {
		const annotation = {
			default: { text: "clean" },
		};
		// Accessor inside an annotation subtree (default) should fail
		Object.defineProperty(annotation.default, "bad", {
			get: () => "bad\uD83Dvalue",
			enumerable: true,
			configurable: true,
		});
		expect(() =>
			assertSchemaAnnotationsSerializable(annotation),
		).toThrow(ElizaError);
	});

	it("skips accessor properties outside annotation subtrees", () => {
		const annotation = { text: "clean" };
		// Top-level accessor is NOT in an annotation subtree, so it's skipped
		Object.defineProperty(annotation, "bad", {
			get: () => "bad\uD83Dvalue",
			enumerable: true,
			configurable: true,
		});
		expect(() =>
			assertSchemaAnnotationsSerializable(annotation),
		).not.toThrow();
	});

	it("fails closed on nesting exceeding maxDepth", () => {
		let annotation: any = { value: "clean" };
		for (let i = 0; i < MAX_WELL_FORMED_DEPTH + 2; i++) {
			annotation = { nested: annotation };
		}
		expect(() =>
			assertSchemaAnnotationsSerializable(annotation),
		).toThrow(ElizaError);
	});

	it("respects custom maxDepth option", () => {
		const annotation = {
			nested: { deep: { deeper: { value: "clean" } } },
		};
		// With maxDepth=1, the deep nesting should fail
		expect(() =>
			assertSchemaAnnotationsSerializable(annotation, { maxDepth: 1 }),
		).toThrow(ElizaError);
		// With maxDepth=10, it should succeed
		expect(() =>
			assertSchemaAnnotationsSerializable(annotation, { maxDepth: 10 }),
		).not.toThrow();
	});

	it("fails closed on cyclic structures", () => {
		const annotation: any = { value: "clean" };
		annotation.self = annotation;
		expect(() =>
			assertSchemaAnnotationsSerializable(annotation),
		).toThrow(ElizaError);
	});

	it("fails closed on cyclic arrays", () => {
		const annotation: any[] = [1, 2];
		annotation.push(annotation);
		expect(() =>
			assertSchemaAnnotationsSerializable(annotation),
		).toThrow(ElizaError);
	});

	it("handles sparse arrays correctly", () => {
		const annotation = [1, , 3];
		expect(() =>
			assertSchemaAnnotationsSerializable(annotation),
		).not.toThrow();
	});

	it("handles arrays with non-index extra keys", () => {
		const annotation: any[] = [1, 2, 3];
		annotation.foo = "bar";
		expect(() =>
			assertSchemaAnnotationsSerializable(annotation),
		).not.toThrow();
	});

	it("fails closed on accessor in nested annotation subtree", () => {
		const annotation = {
			outer: {
				default: { value: "clean" },
			},
		};
		Object.defineProperty(annotation.outer.default, "bad", {
			get: () => "bad\uD83Dvalue",
			enumerable: true,
			configurable: true,
		});
		expect(() =>
			assertSchemaAnnotationsSerializable(annotation),
		).toThrow(ElizaError);
	});

	it("skips non-enumerable properties", () => {
		const annotation = { text: "clean" };
		Object.defineProperty(annotation, "hidden", {
			value: "bad\uD83Dhidden",
			enumerable: false,
			configurable: true,
		});
		expect(() =>
			assertSchemaAnnotationsSerializable(annotation),
		).not.toThrow();
	});

	it("skips non-string keys", () => {
		const annotation = { text: "clean" };
		const sym = Symbol("test");
		(annotation as any)[sym] = "bad\uD83Dsymbol";
		expect(() =>
			assertSchemaAnnotationsSerializable(annotation),
		).not.toThrow();
	});

	it("handles deeply nested arrays", () => {
		let annotation: any = { value: "clean" };
		for (let i = 0; i < 10; i++) {
			annotation = [annotation];
		}
		expect(() =>
			assertSchemaAnnotationsSerializable(annotation),
		).not.toThrow();
	});

	it("fails closed on deeply nested arrays exceeding maxDepth", () => {
		let annotation: any = { value: "clean" };
		for (let i = 0; i < MAX_WELL_FORMED_DEPTH + 2; i++) {
			annotation = [annotation];
		}
		expect(() =>
			assertSchemaAnnotationsSerializable(annotation),
		).toThrow(ElizaError);
	});

	it("handles mixed objects and arrays", () => {
		const annotation = {
			arr: [1, { nested: "clean" }, [2, 3]],
			obj: { arr: [{ deep: "clean" }] },
		};
		expect(() =>
			assertSchemaAnnotationsSerializable(annotation),
		).not.toThrow();
	});

	it("handles large arrays within visit budget", () => {
		const annotation = new Array(1000).fill("clean");
		expect(() =>
			assertSchemaAnnotationsSerializable(annotation),
		).not.toThrow();
	});

	it("handles wide objects within visit budget", () => {
		const annotation: any = {};
		for (let i = 0; i < 100; i++) {
			annotation[`key${i}`] = `value${i}`;
		}
		expect(() =>
			assertSchemaAnnotationsSerializable(annotation),
		).not.toThrow();
	});
});
