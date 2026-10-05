import assert from "node:assert/strict";
import test from "node:test";
import { validateAgainstSchema as validate } from "../json-schema-lite.ts";

test("release schemas reject unsupported constraints even in unselected branches", () => {
  assert.equal(validate("long", { type: "string", maxLength: 1 }).ok, false);
  assert.equal(
    validate(
      1,
      JSON.parse('{"if":{"const":2},"then":{"patternProperties":{}}}'),
    ).ok,
    false,
  );
  assert.equal(validate(1, { type: "made-up" }).ok, false);
  assert.equal(validate(1, { minItems: "1" }).ok, false);
});
test("boolean schemas apply at every supported location", () => {
  assert.equal(validate("anything", false).ok, false);
  assert.equal(validate("anything", true).ok, true);
  assert.equal(validate([1], { items: false }).ok, false);
  assert.equal(
    validate({ blocked: 1 }, { properties: { blocked: false } }).ok,
    false,
  );
  assert.equal(validate(1, JSON.parse('{"if":true,"then":false}')).ok, false);
});
test("calendar dates reject normalized overflow but accept leap days", () => {
  for (const value of ["2026-02-31", "2025-02-29", "2026-13-01"]) {
    assert.equal(validate(value, { type: "string", format: "date" }).ok, false);
  }
  assert.equal(validate("2024-02-29", { format: "date" }).ok, true);
  assert.equal(
    validate("2026-02-31T12:00:00Z", { format: "date-time" }).ok,
    false,
  );
});
test("references retain sibling constraints and decode JSON pointers", () => {
  const schema = {
    $defs: { "a/b": { type: "integer" } },
    $ref: "#/$defs/a~1b",
    minimum: 2,
  };
  assert.equal(validate(1, schema).ok, false);
  assert.equal(validate(2, schema).ok, true);
  assert.equal(
    validate(2, { $defs: { a: { $ref: "#/$defs/a" } }, $ref: "#/$defs/a" }).ok,
    false,
  );
});
test("object checks use own properties and semantic JSON equality", () => {
  assert.equal(validate({}, { required: ["toString"] }).ok, false);
  assert.equal(
    validate(JSON.parse('{"toString":1}'), {
      properties: {},
      additionalProperties: false,
    }).ok,
    false,
  );
  assert.equal(validate({ a: 1, b: 2 }, { const: { b: 2, a: 1 } }).ok, true);
  assert.equal(validate("😀", { minLength: 2 }).ok, false);
  assert.equal(validate(Infinity, { type: "number" }).ok, false);
});
