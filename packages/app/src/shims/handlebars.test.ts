/**
 * Unit tests for the browser Handlebars shim. The suite drives the real
 * default export (not a mock) and records `compile` interpolation, dotted
 * path resolution, nullish-to-empty rendering, skipped block/partial/comment
 * tags, and nullish-context coalescing as implemented. There is no HTML
 * escaping, comparator, queue, removal, or capacity API.
 */
import { describe, expect, it } from "vitest";

import Handlebars from "./handlebars.js";

type TemplateContext = Record<string, unknown>;

describe("handlebars export", () => {
  it("exports a default object whose only method is compile", () => {
    expect(Handlebars).toBeTypeOf("object");
    expect(Handlebars.compile).toBeTypeOf("function");
    expect(Object.keys(Handlebars)).toEqual(["compile"]);
  });
});

describe("handlebars compile factory", () => {
  it("returns a new template function each call without mutating the source", () => {
    const source = "Hello {{name}}";
    const first = Handlebars.compile(source);
    const second = Handlebars.compile(source);
    expect(first).toBeTypeOf("function");
    expect(second).not.toBe(first);
    expect(source).toBe("Hello {{name}}");
    expect(first({ name: "Ada" })).toBe("Hello Ada");
    expect(second({ name: "Bob" })).toBe("Hello Bob");
  });

  it("coalesces a nullish render context to an empty object", () => {
    const render = Handlebars.compile("{{missing}}ok");
    expect(render(null as unknown as TemplateContext)).toBe("ok");
    expect(render(undefined as unknown as TemplateContext)).toBe("ok");
  });
});

describe("handlebars empty, single, and many interpolations", () => {
  it("returns an empty string for an empty template", () => {
    expect(Handlebars.compile("")({})).toBe("");
  });

  it("returns literal text unchanged when there are no mustache tags", () => {
    expect(Handlebars.compile("plain text")({})).toBe("plain text");
    expect(Handlebars.compile("{single}")({})).toBe("{single}");
  });

  it("interpolates a single {{path}} from the context", () => {
    expect(Handlebars.compile("Hi {{name}}")({ name: "Eliza" })).toBe(
      "Hi Eliza",
    );
  });

  it("replaces multiple tags in source order, including adjacent tags", () => {
    const render = Handlebars.compile("{{a}}-{{b}}{{c}}");
    expect(render({ a: "1", b: "2", c: "3" })).toBe("1-23");
  });

  it("repeats the same key independently when it appears twice (tie)", () => {
    expect(Handlebars.compile("{{n}}/{{n}}")({ n: "x" })).toBe("x/x");
  });

  it("renders every interpolation with no capacity or overflow cap", () => {
    const keys = Array.from({ length: 40 }, (_, index) => `k${index}`);
    const template = keys.map((key) => `{{${key}}}`).join("");
    const context: TemplateContext = {};
    for (const [index, key] of keys.entries()) {
      context[key] = String(index);
    }
    expect(Handlebars.compile(template)(context)).toBe(
      keys.map((_, index) => String(index)).join(""),
    );
  });
});

describe("handlebars missing, nullish, and stringify branches", () => {
  it("renders a missing key as an empty string rather than throwing", () => {
    expect(Handlebars.compile("A{{absent}}Z")({})).toBe("AZ");
    expect(Handlebars.compile("{{gone.nested}}")({})).toBe("");
  });

  it("treats null and undefined values as empty strings", () => {
    expect(Handlebars.compile("{{n}}|{{u}}")({ n: null, u: undefined })).toBe(
      "|",
    );
  });

  it("stringifies present falsy primitives instead of treating them as missing", () => {
    expect(
      Handlebars.compile("{{z}}/{{f}}/{{e}}")({
        z: 0,
        f: false,
        e: "",
      }),
    ).toBe("0/false/");
  });

  it("stringifies numbers, arrays, and plain objects with String()", () => {
    expect(Handlebars.compile("{{n}}")({ n: 42 })).toBe("42");
    expect(Handlebars.compile("{{list}}")({ list: [1, 2] })).toBe("1,2");
    expect(Handlebars.compile("{{obj}}")({ obj: { a: 1 } })).toBe(
      "[object Object]",
    );
  });

  it("does not HTML-escape {{path}} or {{{path}}}; both stringify the value", () => {
    const context = { html: "<b>x</b>" };
    expect(Handlebars.compile("{{html}}")(context)).toBe("<b>x</b>");
    expect(Handlebars.compile("{{{html}}}")(context)).toBe("<b>x</b>");
  });

  it("does not re-scan replacement text for further mustache tags", () => {
    expect(Handlebars.compile("{{inner}}")({ inner: "{{oops}}" })).toBe(
      "{{oops}}",
    );
  });
});

describe("handlebars dotted path resolution", () => {
  it("walks dotted paths and returns the nested value", () => {
    expect(Handlebars.compile("{{user.name}}")({ user: { name: "Ada" } })).toBe(
      "Ada",
    );
  });

  it("trims dotted segments and drops empty ones after trim", () => {
    expect(
      Handlebars.compile("{{ user . name }}")({ user: { name: "Ada" } }),
    ).toBe("Ada");
    expect(Handlebars.compile("{{a..b}}")({ a: { b: "ok" } })).toBe("ok");
    expect(Handlebars.compile("{{.name}}")({ name: "Ada" })).toBe("Ada");
    expect(Handlebars.compile("{{name.}}")({ name: "Ada" })).toBe("Ada");
  });

  it("stops at a missing intermediate and yields empty rather than throwing", () => {
    expect(Handlebars.compile("{{user.profile.name}}")({ user: {} })).toBe("");
    expect(Handlebars.compile("{{user.profile.name}}")({})).toBe("");
  });

  it("stops when an intermediate is nullish or a non-object (including 0/false/'')", () => {
    const template = Handlebars.compile("{{user.name}}");
    expect(template({ user: null })).toBe("");
    expect(template({ user: undefined })).toBe("");
    expect(template({ user: 0 })).toBe("");
    expect(template({ user: false })).toBe("");
    expect(template({ user: "" })).toBe("");
    expect(template({ user: 5 })).toBe("");
  });

  it("continues through an empty object or array intermediate", () => {
    expect(Handlebars.compile("{{user.keep}}")({ user: { keep: "yes" } })).toBe(
      "yes",
    );
    expect(Handlebars.compile("{{list.length}}")({ list: [] })).toBe("0");
    expect(
      Handlebars.compile("{{items.0.name}}")({
        items: [{ name: "first" }],
      }),
    ).toBe("first");
  });

  it("stringifies the whole context when every path segment is empty after trim", () => {
    expect(Handlebars.compile("{{.}}")({ keep: 1 })).toBe("[object Object]");
    expect(Handlebars.compile("{{..}}")({ keep: 1 })).toBe("[object Object]");
  });
});

describe("handlebars skipped block, partial, and comment tags", () => {
  it("leaves {{#...}}, {{/...}}, {{>...}}, and {{!...}} tags unreplaced", () => {
    const template = "{{#if}}keep{{/if}}{{>partial}}{{!comment}}{{name}}";
    expect(Handlebars.compile(template)({ name: "Ada" })).toBe(
      "{{#if}}keep{{/if}}{{>partial}}{{!comment}}Ada",
    );
  });

  it("leaves {{}} and {{{}}} unreplaced, but a whitespace-only tag stringifies the context", () => {
    expect(Handlebars.compile("{{}}")({})).toBe("{{}}");
    expect(Handlebars.compile("{{{}}}")({})).toBe("{{{}}}");
    // A space is a legal first capture char; trim+filter then yields no
    // path segments, so resolvePath returns the context itself.
    expect(Handlebars.compile("{{ }}")({})).toBe("[object Object]");
    expect(Handlebars.compile("{{{ }}}")({ keep: 1 })).toBe("[object Object]");
  });

  it("strips surrounding whitespace inside a matched tag", () => {
    expect(Handlebars.compile("{{  name  }}")({ name: "Ada" })).toBe("Ada");
    expect(Handlebars.compile("{{{  name  }}}")({ name: "Ada" })).toBe("Ada");
  });
});
