import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";

const cases: Array<{
  name: string;
  schema: Record<string, unknown>;
  valid: unknown;
  invalid: unknown;
}> = [
  { name: "type:string", schema: { type: "string" }, valid: "a", invalid: 2 },
  { name: "type:number", schema: { type: "number" }, valid: 2, invalid: "2" },
  { name: "type:integer", schema: { type: "integer" }, valid: 2, invalid: 2.5 },
  {
    name: "type:boolean",
    schema: { type: "boolean" },
    valid: true,
    invalid: "true",
  },
  { name: "type:null", schema: { type: "null" }, valid: null, invalid: false },
  { name: "type:object", schema: { type: "object" }, valid: {}, invalid: [] },
  {
    name: "type:array",
    schema: { type: "array", items: { type: "number" } },
    valid: [],
    invalid: {},
  },
  {
    name: "type:union",
    schema: { type: ["string", "null"] },
    valid: null,
    invalid: 2,
  },
  {
    name: "enum",
    schema: { type: "string", enum: ["a", "b"] },
    valid: "a",
    invalid: "c",
  },
  {
    name: "const",
    schema: { type: "string", const: "full" },
    valid: "full",
    invalid: "other",
  },
  {
    name: "required",
    schema: {
      type: "object",
      properties: { value: { type: "boolean" } },
      required: ["value"],
    },
    valid: { value: true },
    invalid: {},
  },
  {
    name: "properties",
    schema: { type: "object", properties: { value: { type: "boolean" } } },
    valid: { value: true },
    invalid: { value: "true" },
  },
  {
    name: "additionalProperties",
    schema: {
      type: "object",
      properties: { value: { type: "boolean" } },
      additionalProperties: false,
    },
    valid: { value: true },
    invalid: { value: true, extra: 1 },
  },
  {
    name: "items",
    schema: { type: "array", items: { type: "number" } },
    valid: [1],
    invalid: ["1"],
  },
  {
    name: "anyOf",
    schema: { anyOf: [{ type: "string" }, { type: "number" }] },
    valid: 1,
    invalid: false,
  },
  {
    name: "minLength",
    schema: { type: "string", minLength: 2 },
    valid: "ab",
    invalid: "a",
  },
  {
    name: "maxLength",
    schema: { type: "string", maxLength: 2 },
    valid: "ab",
    invalid: "abc",
  },
  {
    name: "minimum",
    schema: { type: "number", minimum: 2 },
    valid: 2,
    invalid: 1,
  },
  {
    name: "maximum",
    schema: { type: "number", maximum: 2 },
    valid: 2,
    invalid: 3,
  },
  {
    name: "exclusiveMinimum",
    schema: { type: "number", exclusiveMinimum: 2 },
    valid: 3,
    invalid: 2,
  },
  {
    name: "exclusiveMaximum",
    schema: { type: "number", exclusiveMaximum: 2 },
    valid: 1,
    invalid: 2,
  },
  {
    name: "multipleOf",
    schema: { type: "number", multipleOf: 3 },
    valid: 6,
    invalid: 7,
  },
  {
    name: "minItems",
    schema: { type: "array", items: { type: "number" }, minItems: 2 },
    valid: [1, 2],
    invalid: [1],
  },
  {
    name: "maxItems",
    schema: { type: "array", items: { type: "number" }, maxItems: 2 },
    valid: [1, 2],
    invalid: [1, 2, 3],
  },
];
it.each(cases)(
  "enforces eligible $name without changing valid data",
  ({ schema, valid, invalid }) => {
    const validator = z.fromJSONSchema({ anyOf: [schema] } as Parameters<
      typeof z.fromJSONSchema
    >[0]);
    expect(validator.safeParse(invalid).success).toBe(false);
    const accepted = validator.safeParse(valid);
    expect(accepted.success).toBe(true);
    if (accepted.success) expect(accepted.data).toEqual(valid);
  }
);
it("keeps every eligible validation keyword covered by a negative control", () => {
  const text = readFileSync(new URL("../models/text.ts", import.meta.url), "utf8");
  const start = text.indexOf(
    "  const allowed = new Set([",
    text.indexOf("function wrapCerebrasRootUnion")
  );
  const end = text.indexOf("]);", start);
  expect(start).toBeGreaterThan(0);
  const keys = [...text.slice(start, end).matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  const covered = new Set(cases.map((x) => x.name.split(":")[0]));
  for (const key of keys)
    if (!["$schema", "title", "description"].includes(key))
      expect(covered.has(key), key).toBe(true);
});
