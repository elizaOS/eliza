/**
 * Pins constraint re-expression in the cloud-vendored MCP tool-compatibility
 * formatters, which strip keywords from the schema and must therefore restate
 * every stripped bound in the description the hosted model reads. It also
 * rejects misleading prose for malformed third-party values and preserves the
 * closed-object constraint (#22068, #22115, #22118).
 * Deterministic: the compat objects come from the real
 * `createMcpToolCompatibilitySync` factory over a literal runtime shape, and
 * assertions run against the real `transformToolSchema` output.
 */
import type { IAgentRuntime } from "@elizaos/core";
import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";

import { createMcpToolCompatibilitySync } from "./index";

/** The factory reads only `model`/`modelProvider` off the runtime. */
function compatFor(model: string) {
  const compat = createMcpToolCompatibilitySync({ model } as unknown as IAgentRuntime);
  if (!compat) throw new Error(`no compatibility layer for model ${model}`);
  return compat;
}

const describeOf = (compat: ReturnType<typeof compatFor>, schema: JSONSchema7): string =>
  String(compat.transformToolSchema(schema).description ?? "");

describe("cloud MCP tool-compatibility constraint rendering (#22068, #22115, #22118)", () => {
  describe("google formatter", () => {
    const google = () => compatFor("gemini-2.0-flash");

    it("keeps a zero-valued maxLength alongside a positive minLength", () => {
      const text = describeOf(google(), { type: "string", minLength: 1, maxLength: 0 });
      expect(text).toContain("at least 1 chars");
      expect(text).toContain("at most 0 chars");
    });

    it("keeps a zero-valued maxItems alongside a positive minItems", () => {
      const text = describeOf(google(), { type: "array", minItems: 1, maxItems: 0 });
      expect(text).toContain(">= 1 items");
      expect(text).toContain("<= 0 items");
    });

    it("renders positive bounds unchanged", () => {
      const text = describeOf(google(), { type: "string", minLength: 2, maxLength: 8 });
      expect(text).toBe("Constraints: at least 2 chars; at most 8 chars");
    });

    it("does not throw or invent prose for malformed optional constraints", () => {
      const schema = {
        type: "string",
        enum: null,
        pattern: null,
        minLength: "2",
      } as unknown as JSONSchema7;
      const text = describeOf(google(), schema);

      expect(text).toContain('"enum":null');
      expect(text).toContain('"pattern":null');
      expect(text).toContain('"minLength":"2"');
      expect(text).not.toContain("one of:");
      expect(text).not.toContain("matches null");
      expect(text).not.toContain("at least 2 chars");
    });

    it("preserves a stripped closed-object constraint", () => {
      const out = google().transformToolSchema({
        type: "object",
        additionalProperties: false,
      });

      expect(out.additionalProperties).toBeUndefined();
      expect(out.description).toContain("no additional properties");
    });
  });

  describe("openai reasoning formatter", () => {
    // `o3` is what makes detectModelProvider set isReasoningModel, which is the
    // only way the factory constructs OpenAIReasoningMcpCompatibility.
    const reasoning = () => compatFor("o3-mini");

    it("is the class the factory builds for a reasoning model", () => {
      expect(reasoning().constructor.name).toBe("OpenAIReasoningMcpCompatibility");
    });

    it("keeps a zero-valued maxLength alongside a positive minLength", () => {
      const text = describeOf(reasoning(), { type: "string", minLength: 1, maxLength: 0 });
      expect(text).toContain("minimum 1 characters");
      expect(text).toContain("maximum 0 characters");
    });

    it("restates multipleOf when another numeric rule also matched", () => {
      const schema: JSONSchema7 = { type: "number", minimum: 1, multipleOf: 0.5 };
      const out = reasoning().transformToolSchema(schema);
      const text = String(out.description ?? "");
      expect(text).toContain("must be >= 1");
      expect(text).toContain("0.5");
      // The keyword is still stripped from the schema, which is why the
      // description is the only place the model can learn about it.
      expect(out.multipleOf).toBeUndefined();
    });

    it("restates exclusive bounds that the schema strips", () => {
      const text = describeOf(reasoning(), {
        type: "number",
        exclusiveMinimum: 0,
        exclusiveMaximum: 10,
      });
      expect(text).toContain("must be > 0");
      expect(text).toContain("must be < 10");
    });

    it("does not turn uniqueItems false into a uniqueness requirement", () => {
      const out = reasoning().transformToolSchema({
        type: "array",
        uniqueItems: false,
      });
      expect(out.uniqueItems).toBeUndefined();
      expect(out.description).toContain('"uniqueItems":false');
      expect(out.description).not.toContain("items must be unique");
    });

    it("does not throw or invent prose for malformed optional constraints", () => {
      const schema = {
        type: "number",
        enum: null,
        pattern: null,
        exclusiveMinimum: true,
        multipleOf: "2",
      } as unknown as JSONSchema7;
      const text = describeOf(reasoning(), schema);

      expect(text).toContain('"enum":null');
      expect(text).toContain('"pattern":null');
      expect(text).toContain('"exclusiveMinimum":true');
      expect(text).toContain('"multipleOf":"2"');
      expect(text).not.toContain("must be one of:");
      expect(text).not.toContain("must match: null");
      expect(text).not.toContain("must be > true");
      expect(text).not.toContain("multiple of 2");
    });

    it("keeps empty enums in the unrendered tail and renders non-empty enums exactly", () => {
      const empty = describeOf(reasoning(), { type: "string", enum: [] });
      expect(empty).toContain('"enum":[]');
      expect(empty).not.toContain("must be one of:");

      const populated = describeOf(reasoning(), {
        type: "string",
        enum: ["alpha", "beta"],
      });
      expect(populated).toContain('must be one of: "alpha", "beta"');
      expect(populated).not.toContain('{"enum"');
    });

    it("preserves false additionalProperties without inverting true", () => {
      const closed = reasoning().transformToolSchema({
        type: "object",
        additionalProperties: false,
      });
      expect(closed.additionalProperties).toBeUndefined();
      expect(closed.description).toContain("must not contain additional properties");

      const open = reasoning().transformToolSchema({
        type: "object",
        additionalProperties: true,
      });
      expect(open.additionalProperties).toBeUndefined();
      expect(open.description).toContain('"additionalProperties":true');
      expect(open.description).not.toContain("must not contain additional properties");
    });

    it("surfaces a collected keyword that has no rule instead of dropping it", () => {
      const text = describeOf(reasoning(), {
        type: "string",
        minLength: 1,
        format: "date-time",
      });
      expect(text).toContain("minimum 1 characters");
      expect(text).toContain("date-time");
    });

    it("renders a fully-ruled positive constraint set without a raw json tail", () => {
      const text = describeOf(reasoning(), { type: "string", minLength: 2, maxLength: 8 });
      expect(text).toBe("IMPORTANT: minimum 2 characters, maximum 8 characters");
    });

    it("renders a uniqueness requirement when uniqueItems is true", () => {
      expect(describeOf(reasoning(), { type: "array", uniqueItems: true })).toContain(
        "items must be unique",
      );
    });

    it("does not throw when an untrusted schema supplies a non-array enum", () => {
      const malformed = { type: "string", enum: null } as unknown as JSONSchema7;
      expect(() => describeOf(reasoning(), malformed)).not.toThrow();
      expect(describeOf(reasoning(), malformed)).toContain('"enum":null');
    });

    it("restates and strips object property bounds", () => {
      const out = reasoning().transformToolSchema({
        type: "object",
        minProperties: 0,
        maxProperties: 2,
      });
      expect(out.description).toContain("at least 0 properties");
      expect(out.description).toContain("at most 2 properties");
      expect(out.minProperties).toBeUndefined();
      expect(out.maxProperties).toBeUndefined();
    });
  });
});
