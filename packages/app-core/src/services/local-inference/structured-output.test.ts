import type { ResponseSkeleton } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  canonicalizeShortName,
  collapseSkeleton,
  compilePrefillPlan,
  compileSkeletonToGbnf,
  elizaHarnessSchemaFromSkeleton,
  expandShortName,
  grammarRequestFields,
  prefillPlanRequestFields,
  resolveGrammarForParams,
  resolveGuidedDecodeForParams,
  splitSkeletonAtFirstFree,
} from "./structured-output";

const envelopeSkeleton: ResponseSkeleton = {
  id: "response-v1",
  spans: [
    { kind: "literal", value: '{\n  "shouldRespond": "' },
    {
      kind: "enum",
      key: "shouldRespond",
      enumValues: ["RESPOND", "IGNORE", "STOP"],
    },
    { kind: "literal", value: '",\n  "replyText": "' },
    { kind: "free-string", key: "replyText" },
    { kind: "literal", value: '",\n  "contexts": ' },
    { kind: "free-json", key: "contexts" },
    { kind: "literal", value: ',\n  "extract": ' },
    { kind: "free-json", key: "extract" },
    { kind: "literal", value: "\n}" },
  ],
};

describe("collapseSkeleton (C4 — single-value enum/option skip)", () => {
  it("lowers a single-value enum to a literal", () => {
    const collapsed = collapseSkeleton({
      spans: [
        { kind: "literal", value: '"x": "' },
        { kind: "enum", key: "x", enumValues: ["only"] },
        { kind: "literal", value: '"' },
      ],
    });
    expect(collapsed.spans.map((s) => s.kind)).toEqual([
      "literal",
      "literal",
      "literal",
    ]);
    expect(collapsed.spans[1]).toEqual({
      kind: "literal",
      key: "x",
      value: "only",
    });
  });

  it("keeps a multi-value enum as an enum span", () => {
    const collapsed = collapseSkeleton(envelopeSkeleton);
    expect(collapsed.spans.some((s) => s.kind === "enum")).toBe(true);
  });
});

describe("compileSkeletonToGbnf", () => {
  it("compiles the response envelope into a lazy GBNF with the right root", () => {
    const grammar = compileSkeletonToGbnf(envelopeSkeleton);
    expect(grammar).not.toBeNull();
    expect(grammar?.lazy).toBe(true);
    expect(grammar?.triggers).toEqual(['{\n  "shouldRespond": "']);
    // root concatenates the spans: leading literal, enum rule, more literals,
    // a free-string rule, then two json-value rules.
    expect(grammar?.source.startsWith("root ::= ")).toBe(true);
    expect(grammar?.source).toContain("jsonvalue");
    // The enum alternation lists all three values as GBNF string literals of
    // the JSON-quoted value (i.e. `"\"RESPOND\""`).
    expect(grammar?.source).toContain('\\"RESPOND\\"');
    expect(grammar?.source).toContain('\\"IGNORE\\"');
    expect(grammar?.source).toContain('\\"STOP\\"');
  });

  it("returns null when the skeleton is all literal (nothing to sample)", () => {
    expect(
      compileSkeletonToGbnf({ spans: [{ kind: "literal", value: "{}" }] }),
    ).toBeNull();
  });

  it("collapses a single-value enum span — no rule emitted for it", () => {
    const grammar = compileSkeletonToGbnf({
      spans: [
        { kind: "literal", value: '{"a":"' },
        { kind: "enum", key: "a", enumValues: ["fixed"] },
        { kind: "literal", value: '","b":"' },
        { kind: "free-string", key: "b" },
        { kind: "literal", value: '"}' },
      ],
    });
    expect(grammar).not.toBeNull();
    // The collapsed enum becomes a literal in the root; only the free-string
    // gets its own rule.
    const ruleLines =
      grammar?.source.split("\n").filter((l) => l.includes("::=")) ?? [];
    // root + exactly one free-string rule (jsonstring/freestr).
    expect(ruleLines.length).toBe(2);
  });
});

describe("resolveGrammarForParams precedence", () => {
  it("an explicit grammar string wins over a responseSkeleton", () => {
    const g = resolveGrammarForParams({
      grammar: 'root ::= "hi"',
      responseSkeleton: envelopeSkeleton,
    });
    expect(g?.source).toBe('root ::= "hi"');
    expect(g?.lazy).toBe(false);
  });

  it("falls back to compiling the responseSkeleton", () => {
    const g = resolveGrammarForParams({ responseSkeleton: envelopeSkeleton });
    expect(g?.lazy).toBe(true);
  });

  it("returns null when neither is set", () => {
    expect(resolveGrammarForParams({})).toBeNull();
    expect(resolveGrammarForParams(undefined)).toBeNull();
  });
});

describe("grammarRequestFields", () => {
  it("emits grammar + grammar_lazy + grammar_triggers for a lazy grammar", () => {
    const fields = grammarRequestFields({
      source: "root ::= rule",
      lazy: true,
      triggers: ['"shouldRespond": "'],
    });
    expect(fields.grammar).toBe("root ::= rule");
    expect(fields.grammar_lazy).toBe(true);
    expect(fields.grammar_triggers).toEqual([
      { type: "word", value: '"shouldRespond": "' },
    ]);
  });

  it("emits only grammar for a non-lazy grammar", () => {
    expect(grammarRequestFields({ source: "root ::= x" })).toEqual({
      grammar: "root ::= x",
    });
  });
});

describe("splitSkeletonAtFirstFree", () => {
  it("peels the leading literal run off as a prefill candidate", () => {
    const { prefixLiteral, rest } = splitSkeletonAtFirstFree(envelopeSkeleton);
    expect(prefixLiteral).toBe('{\n  "shouldRespond": "');
    expect(rest[0]).toEqual({
      kind: "enum",
      key: "shouldRespond",
      enumValues: ["RESPOND", "IGNORE", "STOP"],
    });
  });
});

describe("compilePrefillPlan + prefillPlanRequestFields", () => {
  it("merges adjacent literals into one deterministic run and counts free spans", () => {
    const plan = compilePrefillPlan(envelopeSkeleton);
    expect(plan).not.toBeNull();
    if (!plan) return;
    expect(plan.prefix).toBe('{\n  "shouldRespond": "');
    expect(plan.freeCount).toBe(4); // shouldRespond enum, replyText, contexts, extract
    expect(plan.runs[0]).toEqual({
      afterFreeSpan: -1,
      text: '{\n  "shouldRespond": "',
    });
    // The tail closing literal is the run after the last free span.
    expect(plan.runs[plan.runs.length - 1]).toEqual({
      afterFreeSpan: 3,
      text: "\n}",
    });
  });

  it("the request fragment carries the plan; empty when null", () => {
    const plan = compilePrefillPlan(envelopeSkeleton);
    const fields = prefillPlanRequestFields(plan);
    expect(fields.eliza_prefill_plan).toBeDefined();
    expect(prefillPlanRequestFields(null)).toEqual({});
  });
});

describe("elizaHarnessSchemaFromSkeleton", () => {
  it("bundles the skeleton, grammar, prefill plan and name map", () => {
    const schema = elizaHarnessSchemaFromSkeleton({
      skeleton: envelopeSkeleton,
      grammar: 'root ::= "x"',
      longNames: { RESPOND: "Respond to the user" },
    });
    expect(schema.skeleton).toBe(envelopeSkeleton);
    expect(schema.grammar).toBe('root ::= "x"');
    expect(schema.prefillPlan).not.toBeNull();
    expect(schema.longNames.RESPOND).toBe("Respond to the user");
    expect(schema.id).toBe("response-v1");
  });
});

describe("resolveGuidedDecodeForParams", () => {
  it("returns the grammar + prefill plan + leading-run prefill for an elizaSchema", () => {
    const schema = elizaHarnessSchemaFromSkeleton({
      skeleton: envelopeSkeleton,
    });
    const out = resolveGuidedDecodeForParams({ elizaSchema: schema });
    expect(out.grammar?.lazy).toBe(true);
    expect(out.prefillPlan).not.toBeNull();
    expect(out.prefill).toBe('{\n  "shouldRespond": "');
  });

  it("prefers the schema's pre-built grammar over compiling the skeleton", () => {
    const schema = elizaHarnessSchemaFromSkeleton({
      skeleton: envelopeSkeleton,
      grammar: 'root ::= "hi"',
    });
    const out = resolveGuidedDecodeForParams({ elizaSchema: schema });
    expect(out.grammar?.source).toBe('root ::= "hi"');
    expect(out.grammar?.lazy).toBe(false);
  });

  it("an explicit prefill on the params wins over the plan's leading run", () => {
    const schema = elizaHarnessSchemaFromSkeleton({
      skeleton: envelopeSkeleton,
    });
    const out = resolveGuidedDecodeForParams({
      elizaSchema: schema,
      prefill: "seed:",
    });
    expect(out.prefill).toBe("seed:");
  });

  it("no elizaSchema → no prefill plan (guided decode off), bare grammar still resolved", () => {
    const out = resolveGuidedDecodeForParams({ grammar: 'root ::= "x"' });
    expect(out.prefillPlan).toBeNull();
    expect(out.grammar?.source).toBe('root ::= "x"');
    expect(out.prefill).toBeNull();
  });
});

describe("short ↔ long name round-trip", () => {
  it("expands a decoded short id to its display label and back", () => {
    const schema = elizaHarnessSchemaFromSkeleton({
      skeleton: envelopeSkeleton,
      longNames: { SEND_MESSAGE: "Send a message" },
    });
    expect(expandShortName(schema, "SEND_MESSAGE")).toBe("Send a message");
    expect(canonicalizeShortName(schema, "Send a message")).toBe(
      "SEND_MESSAGE",
    );
    // Identity for an unmapped value (canonical ids are already the wire form).
    expect(expandShortName(schema, "IGNORE")).toBe("IGNORE");
    expect(canonicalizeShortName(schema, "IGNORE")).toBe("IGNORE");
    expect(expandShortName(undefined, "X")).toBe("X");
    expect(canonicalizeShortName(undefined, "X")).toBe("X");
  });
});
