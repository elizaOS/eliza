/** Verifies OpenAPI YAML export preserves adversarial scalar content through a standards-based serializer. */

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { serializeOpenAPIYAML } from "./openapi-generator";

describe("serializeOpenAPIYAML", () => {
  it("round-trips quotes, backslashes, newlines, comments, and YAML keywords", () => {
    const sharedSchema = { type: "string" };
    const value = {
      description: 'quote " and slash \\ and\nnext: # literal',
      keyword: "true",
      timestamp: "2026-08-20",
      sharedA: sharedSchema,
      sharedB: sharedSchema,
    };
    const yaml = serializeOpenAPIYAML(value);
    expect(yaml).not.toMatch(/[&*][A-Za-z0-9_-]+/);
    expect(parse(yaml)).toEqual(value);
  });
});
