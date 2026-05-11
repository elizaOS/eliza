import type { ResponseSkeleton } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  collapseSkeleton,
  compileSkeletonToGbnf,
  grammarRequestFields,
  resolveGrammarForParams,
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
