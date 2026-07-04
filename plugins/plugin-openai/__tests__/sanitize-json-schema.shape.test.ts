/**
 * sanitizeJsonSchema is the single wire choke point every response_format
 * schema and every tool schema funnels through. Strict-grammar providers
 * (Cerebras via Eliza Cloud, OpenAI strict) reject a fixed set of constraint
 * keywords with a hard 400 that fails the ENTIRE request — bisected live
 * against api.elizacloud.ai/gpt-oss-120b (#11123/#11141). These tests lock the
 * strip behavior: the rejected keywords must never survive to the wire, at any
 * depth, and the intent must be preserved in `description`.
 */

import { describe, expect, it } from "vitest";
import { __INTERNAL_sanitizeJsonSchema as sanitize } from "../models/text";

// Keywords bisected as REJECTED by the strict grammar.
const REJECTED = [
  ["maxItems", 3],
  ["minItems", 1],
  ["maxLength", 10],
  ["minLength", 1],
  ["pattern", "^x"],
  ["format", "date-time"],
  ["minProperties", 1],
  ["maxProperties", 4],
] as const;

// Bisected as ACCEPTED — must be left untouched.
const ACCEPTED = [
  ["minimum", 0],
  ["maximum", 20],
  ["multipleOf", 2],
  ["uniqueItems", true],
] as const;

function collectKeys(node: unknown, acc = new Set<string>()): Set<string> {
  if (!node || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    for (const item of node) collectKeys(item, acc);
    return acc;
  }
  for (const [key, value] of Object.entries(node)) {
    acc.add(key);
    collectKeys(value, acc);
  }
  return acc;
}

describe("sanitizeJsonSchema strict-constraint stripping", () => {
  for (const [keyword, value] of REJECTED) {
    it(`strips ${keyword} and folds it into description`, () => {
      const out = sanitize({
        type: "object",
        properties: { a: { type: "string", [keyword]: value } },
        required: ["a"],
        additionalProperties: false,
      });
      const prop = (out.properties as Record<string, Record<string, unknown>>).a;
      expect(prop[keyword]).toBeUndefined();
      expect(typeof prop.description).toBe("string");
      expect((prop.description as string).length).toBeGreaterThan(0);
    });
  }

  for (const [keyword, value] of ACCEPTED) {
    it(`preserves ${keyword} (accepted by the grammar)`, () => {
      const out = sanitize({
        type: "object",
        properties: { a: { type: "number", [keyword]: value } },
        required: ["a"],
        additionalProperties: false,
      });
      const prop = (out.properties as Record<string, Record<string, unknown>>).a;
      expect(prop[keyword]).toBe(value);
    });
  }

  it("strips rejected keywords at every depth (nested arrays, unions)", () => {
    const out = sanitize({
      type: "object",
      properties: {
        list: {
          type: "array",
          maxItems: 5,
          items: {
            type: "object",
            properties: {
              tags: { type: "array", items: { type: "string" }, minItems: 1 },
              code: { type: "string", pattern: "^[A-Z]+$" },
            },
          },
        },
        choice: {
          anyOf: [
            { type: "string", maxLength: 8 },
            { type: "object", properties: {}, minProperties: 1 },
          ],
        },
      },
      required: ["list"],
      additionalProperties: false,
    });
    const keys = collectKeys(out);
    for (const [keyword] of REJECTED) {
      expect(keys.has(keyword)).toBe(false);
    }
  });

  it("strips rejected keywords inside $defs / patternProperties / contains", () => {
    const out = sanitize({
      type: "object",
      properties: { ref: { $ref: "#/$defs/code" } },
      required: ["ref"],
      additionalProperties: false,
      // zod's toJSONSchema hoists reused/nullable sub-schemas here.
      $defs: { code: { type: "string", pattern: "^[A-Z]+$", maxLength: 4 } },
      patternProperties: {
        "^x": { type: "array", items: { type: "string" }, maxItems: 2 },
      },
      contains: { type: "string", minLength: 1 },
    });
    const keys = collectKeys(out);
    for (const [keyword] of REJECTED) {
      expect(keys.has(keyword)).toBe(false);
    }
  });

  it("preserves an existing description when folding a hint", () => {
    const out = sanitize({
      type: "object",
      properties: {
        kw: {
          type: "array",
          items: { type: "string" },
          maxItems: 16,
          description: "Search keywords.",
        },
      },
      required: ["kw"],
      additionalProperties: false,
    });
    const prop = (out.properties as Record<string, Record<string, unknown>>).kw;
    expect(prop.maxItems).toBeUndefined();
    expect(prop.description).toContain("Search keywords.");
    expect(prop.description).toContain("16");
  });

  it("still forces additionalProperties:false + required on objects (unchanged)", () => {
    const out = sanitize({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
    });
    expect(out.additionalProperties).toBe(false);
    expect(new Set(out.required as string[])).toEqual(new Set(["a", "b"]));
  });
});

/**
 * A DECLARED free-form/open map (`additionalProperties: {type:"string"}` or
 * `true`) must still be closed on the wire (strict providers 400 on open maps,
 * and strictness is proxy-blind), but the intent must survive in `description`
 * instead of being lost silently, so the map arg no longer always arrives empty
 * (#11249).
 */
describe("sanitizeJsonSchema free-form record args (#11249)", () => {
  it("closes a schema-valued additionalProperties but folds the intent into description", () => {
    const out = sanitize({
      type: "object",
      properties: {
        customFields: {
          type: "object",
          additionalProperties: { type: "string" },
        },
      },
      required: ["customFields"],
      additionalProperties: false,
    });
    const prop = (out.properties as Record<string, Record<string, unknown>>).customFields;
    // Still closed on the wire — no strict-grammar 400.
    expect(prop.additionalProperties).toBe(false);
    // Intent preserved (with the value type), not lost silently.
    expect(typeof prop.description).toBe("string");
    expect(prop.description as string).toContain("string");
    expect(prop.description as string).toMatch(/key\/value pairs/);
  });

  it("closes additionalProperties:true and records the open-map intent", () => {
    const out = sanitize({
      type: "object",
      properties: {
        attributes: { type: "object", additionalProperties: true },
      },
      required: ["attributes"],
      additionalProperties: false,
    });
    const prop = (out.properties as Record<string, Record<string, unknown>>).attributes;
    expect(prop.additionalProperties).toBe(false);
    expect(prop.description as string).toMatch(/key\/value pairs/);
  });

  it("does NOT add a hint to a plain object that never declared additionalProperties", () => {
    const out = sanitize({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    });
    // Closed as before, but no spurious open-map hint on a normal object.
    expect(out.additionalProperties).toBe(false);
    expect(out.description).toBeUndefined();
  });

  it("preserves an existing description when folding the open-map hint", () => {
    const out = sanitize({
      type: "object",
      properties: {
        prefs: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "User preferences.",
        },
      },
      required: ["prefs"],
      additionalProperties: false,
    });
    const prop = (out.properties as Record<string, Record<string, unknown>>).prefs;
    expect(prop.description as string).toContain("User preferences.");
    expect(prop.description as string).toMatch(/key\/value pairs/);
    expect(prop.additionalProperties).toBe(false);
  });

  it("closes nested free-form maps at any depth (no open map survives to the wire)", () => {
    const out = sanitize({
      type: "object",
      properties: {
        list: {
          type: "array",
          items: { type: "object", additionalProperties: { type: "number" } },
        },
        map: { type: "object", additionalProperties: true },
      },
      required: ["list", "map"],
      additionalProperties: false,
    });
    // No truthy additionalProperties anywhere — every object is closed.
    const keys = collectKeys(out);
    expect(keys.has("additionalProperties")).toBe(true);
    const openMapSurvived = JSON.stringify(out).includes('"additionalProperties":true');
    expect(openMapSurvived).toBe(false);
    const itemProp = (
      (out.properties as Record<string, Record<string, unknown>>).list.items as Record<
        string,
        unknown
      >
    ).additionalProperties;
    expect(itemProp).toBe(false);
  });
});
