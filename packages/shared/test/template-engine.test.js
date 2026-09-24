/**
 * Compares complete rendered prompts against Handlebars and executes the actual
 * renderer with V8 code generation disabled, including runtime extension boundaries.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import Handlebars from "handlebars";
import { compileTemplate } from "../dist/text/template-rendering.js";
import { authoredTemplates as prompts } from "./authored-template-fixtures.ts";

const contexts = [
  {},
  {
    yes: true,
    zero: 0,
    title: "root",
    value: "<&> {{opaque}}",
    person: { name: "Ada" },
    map: { x: "X", y: "Y" },
    items: [
      { name: "one", children: ["a", "b"] },
      { name: "two", children: ["c"] },
    ],
  },
  { yes: false, value: 0, items: [], map: {} },
];
const syntax = [
  "{{value}}|{{{value}}}",
  "{{#if yes}}yes{{else}}no{{/if}}",
  "{{#unless yes}}no{{else}}yes{{/unless}}",
  "{{#each items}}{{@index}}:{{this.name}}:{{../title}}:{{@root.title}}:{{@first}}:{{@last}};{{else}}empty{{/each}}",
  "{{#each map}}{{@key}}={{this}};{{/each}}",
  "{{#with person}}{{name}}:{{../title}}{{else}}none{{/with}}",
  "{{#each items as |item idx|}}{{idx}}={{item.name}}{{/each}}",
  "{{#each items}}{{#each children}}{{../../title}}:{{../name}}:{{@../index}}:{{this}}{{/each}}{{/each}}",
  "{{lookup person 'name'}}",
  "{{#if (lookup person 'name')}}present{{/if}}",
  "{{#items}}{{name}}{{/items}}",
  "a\n {{#if yes}}\n b {{value}}\n {{else}}\n c\n {{/if}}\n d",
  "{{#if zero includeZero=true}}zero{{else}}missing{{/if}}",
  "{{#if no}}A{{else if yes}}B{{else}}C{{/if}}",
  "{{undefined}}|{{null}}|{{false}}|{{0}}|{{'hello'}}",
  "{{!comment}}{{!-- long --}}{{~value~}}",
  "{{#each items as |item|}}{{#if item.name}}{{item.name}}{{/if}}{{/each}}",
  "{{#each items as |item i|}}{{#each item.children as |child|}}{{i}}:{{item.name}}:{{child}}{{/each}}{{/each}}",
];
function compare(template, context, options = {}) {
  assert.equal(
    compileTemplate(template)(context, options),
    Handlebars.compile(template)(context, options),
    template,
  );
}

describe("interpreted template rendering", () => {
  it("preserves blocks, paths, whitespace, iteration metadata and nested lexical bindings", () => {
    for (const template of syntax)
      for (const context of contexts) compare(template, context);
  });

  it("renders every authored prompt without a code-generating runtime", () => {
    const payloads = [
      {},
      {
        agentName: "Ada",
        providers: `${"<&> {{opaque}}\n".repeat(16384)}END`,
        recentMessages: "complete dialogue",
        bio: "Biography",
      },
    ];
    const cases = [
      ...new Set(
        Object.values(prompts).filter((value) => typeof value === "string"),
      ),
    ].flatMap((template) =>
      payloads.map((context) => ({
        template,
        context,
        expected: Handlebars.compile(template)(context),
      })),
    );
    for (const row of cases)
      assert.equal(compileTemplate(row.template)(row.context), row.expected);
    const script = `
      import assert from 'node:assert/strict';
      import {readFileSync} from 'node:fs';
      import {compileTemplate} from ${JSON.stringify(new URL("../dist/text/template-rendering.js", import.meta.url).href)};
      assert.throws(() => new Function('return 1'), EvalError);
      for (const row of JSON.parse(readFileSync(0, 'utf8'))) {
        assert.equal(compileTemplate(row.template)(row.context), row.expected);
      }
    `;
    const result = spawnSync(
      "node",
      [
        "--disallow-code-generation-from-strings",
        "--input-type=module",
        "-e",
        script,
      ],
      {
        input: JSON.stringify(cases),
        encoding: "utf8",
        timeout: 30000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  });

  it("retains empty and nonempty collection and conditional semantics", () => {
    const values = [
      undefined,
      null,
      false,
      true,
      0,
      1,
      "",
      "x",
      [],
      [0],
      {},
      { a: 1 },
      new Set(["a", "b"]),
      new Map([["a", 1]]),
    ];
    for (const value of values)
      for (const template of [
        "{{value}}|{{{value}}}",
        "{{#if value}}Y{{else}}N{{/if}}",
        "{{#unless value}}N{{else}}Y{{/unless}}",
        "{{#with value}}{{this}}{{else}}empty{{/with}}",
        "{{#each value}}{{@key}}:{{@index}}:{{this}};{{else}}empty{{/each}}",
        "{{#value}}{{this}}{{else}}empty{{/value}}",
      ])
        compare(template, { value });
  });

  it("retains custom helpers, function values and SafeString escaping", () => {
    const context = {
      name: "Ada",
      value: new Handlebars.SafeString("<b>Ada</b>"),
      label(options) {
        return options?.name ?? "path";
      },
    };
    const options = {
      helpers: {
        upper: (value) => String(value).toUpperCase(),
        around(options) {
          return `[${options.fn(this)}]`;
        },
        "person.name": () => "must not shadow a path",
      },
    };
    for (const template of [
      "{{upper name}}",
      "{{#around}}{{name}}{{/around}}",
      "{{label}}|{{this.label}}",
      "{{value}}|{{{value}}}",
    ])
      compare(template, context, options);
    compare("{{person.name}}", { person: { name: "Ada" } }, options);
  });

  it("retains runtime partials, decorators, inline scopes and dynamic names", () => {
    const options = {
      helpers: { choose: (value) => (value ? "greeting" : "multiline") },
      partials: {
        greeting: "Hello {{name}}",
        multiline: "A\n{{name}}\nB\n",
        layout: "<{{> @partial-block}}>",
      },
      decorators: {
        upperOutput: (fn) => (context, options) =>
          fn(context, options).toUpperCase(),
      },
    };
    for (const template of [
      "{{*upperOutput}}Hello {{name}}",
      "{{> greeting}}",
      "{{> greeting person}}",
      "{{> greeting name='Override'}}",
      "A\n  {{> multiline}}\nZ",
      "{{> (choose yes)}}",
      "{{#> absent}}fallback {{name}}{{/absent}}",
      "{{#> layout}}body {{name}}{{/layout}}",
      "{{#*inline 'local'}}Hello {{name}}{{/inline}}{{> local}}",
      "{{> local}}{{#*inline 'local'}}Hello {{name}}{{/inline}}",
    ])
      compare(
        template,
        { name: "Ada", yes: true, person: { name: "Bea" } },
        options,
      );
  });

  it("isolates separately parsed partial scopes while retaining root data", () => {
    const options = {
      partials: {
        outer: "OUT {{> inner}}",
        inner: "{{../name}}/{{@root.name}}",
      },
    };
    const context = { name: "ROOT", person: { name: "CHILD" } };
    compare("{{> inner person}}", context, options);
    compare("{{> outer person}}", context, options);
    compare("{{#each items as |__proto__|}}{{__proto__.name}}{{/each}}", {
      items: [{ name: "Ada" }],
    });
  });

  it("renders registered empty partials instead of treating them as missing", () => {
    const options = { partials: { blank: "" } };
    compare("before{{> blank}}after", {}, options);
    compare("{{#> blank}}fallback{{/blank}}", {}, options);
  });

  it("preserves runtime data roots without modifying caller data", () => {
    const data = { index: 42 };
    compare("{{@root.name}}:{{@index}}", { name: "Ada" }, { data });
    assert.deepEqual(data, { index: 42 });
    compare(
      "{{@root.name}}",
      { name: "Ada" },
      { data: { root: { name: "Override" } } },
    );
  });

  it("retains own-property and explicit prototype-access boundaries", () => {
    const context = Object.assign(
      Object.create({
        name: "inherited",
        method() {
          return "method";
        },
      }),
      { own: "owned" },
    );
    for (const options of [
      {},
      { allowProtoPropertiesByDefault: true },
      { allowProtoMethodsByDefault: true },
      { allowedProtoProperties: { name: true } },
      { allowedProtoMethods: { method: true } },
      {
        allowProtoPropertiesByDefault: true,
        allowedProtoProperties: { name: false },
      },
    ]) {
      compare(
        "{{own}}:{{name}}:{{method}}:{{constructor}}:{{__proto__}}",
        context,
        options,
      );
    }
    compare("{{lookup person key}}", { person: context, key: "name" });
  });

  it("rejects invalid syntax, missing helpers and partials and non-string AST input", () => {
    for (const source of [
      "{{#if x}}",
      "{{missing value}}",
      "{{> missing}}",
      "{{helperMissing value}}",
      "{{#blockHelperMissing value}}x{{/blockHelperMissing}}",
    ]) {
      assert.throws(() => Handlebars.compile(source)({ value: "x" }));
      assert.throws(() => compileTemplate(source)({ value: "x" }));
    }
    assert.throws(
      () => compileTemplate(Handlebars.parse("{{value}}")),
      TypeError,
    );
    compare("{{helperMissing}}", {}, { allowCallsToHelperMissing: true });
    compare(
      "{{#blockHelperMissing value}}yes{{/blockHelperMissing}}",
      { value: true },
      { allowCallsToHelperMissing: true },
    );
    compare("{{missing}}", {}, { helpers: { helperMissing: () => "missing" } });
  });
});
