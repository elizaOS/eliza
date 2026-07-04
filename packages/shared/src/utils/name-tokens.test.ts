import { describe, expect, it } from "vitest";
import {
  replaceIndexedNameTokens,
  replaceNameTokens,
  tokenizeNameOccurrences,
} from "./name-tokens";

/**
 * Character-name token helpers. `replaceNameTokens` expands `{{name}}` /
 * `{{agentName}}` into the literal name; `tokenizeNameOccurrences` reverses
 * it during rename so every text field keeps propagating. Both run on
 * user-entered names, so `$`-sequences and non-ASCII names must round-trip.
 */

describe("replaceNameTokens", () => {
  it("replaces both token spellings with the name", () => {
    expect(replaceNameTokens("Hi {{name}}, aka {{agentName}}.", "Momo")).toBe(
      "Hi Momo, aka Momo.",
    );
  });

  it("inserts names containing $-sequences literally", () => {
    // "$$" is a String.replace substitution pattern for a single "$";
    // the raw name must survive unmangled.
    expect(replaceNameTokens("hello {{name}}", "Cash$$")).toBe("hello Cash$$");
    // "$&" would re-insert the matched token itself.
    expect(replaceNameTokens("hello {{name}}", "M$&M")).toBe("hello M$&M");
    expect(replaceNameTokens("yo {{agentName}}", "A$AP")).toBe("yo A$AP");
  });

  it("tolerates whitespace inside the braces (reconciled canonical behavior)", () => {
    // The pre-consolidation shared copy required tight `{{name}}`; the core
    // copy allowed `{{ name }}`. The single canonical impl is whitespace-
    // tolerant so both spellings resolve the same everywhere.
    expect(replaceNameTokens("Hi {{ name }}!", "Momo")).toBe("Hi Momo!");
    expect(replaceNameTokens("Hi {{  agentName  }}!", "Momo")).toBe("Hi Momo!");
  });

  it("returns empty/falsey input unchanged", () => {
    expect(replaceNameTokens("", "Momo")).toBe("");
  });
});

describe("replaceIndexedNameTokens (re-exported from core)", () => {
  it("resolves indexed example-slot tokens $-safely", () => {
    expect(
      replaceIndexedNameTokens("{{name1}} met {{user2}}", ["Ada", "Bo"]),
    ).toBe("Ada met Bo");
    // Same $-sequence protection as replaceNameTokens; the former `.replaceAll`
    // mirrors mangled these.
    expect(replaceIndexedNameTokens("{{name1}}", ["Cash$$"])).toBe("Cash$$");
    expect(replaceIndexedNameTokens("{{name1}}", ["M$&M"])).toBe("M$&M");
  });
});

describe("tokenizeNameOccurrences", () => {
  it("tokenizes whole-word occurrences only, case-sensitively", () => {
    expect(tokenizeNameOccurrences("Momo says Momos love Momo.", "Momo")).toBe(
      "{{name}} says Momos love {{name}}.",
    );
    expect(tokenizeNameOccurrences("momo stays", "Momo")).toBe("momo stays");
  });

  it("is idempotent and non-destructive on empty/short names", () => {
    expect(tokenizeNameOccurrences("{{name}} waves", "Momo")).toBe(
      "{{name}} waves",
    );
    expect(tokenizeNameOccurrences("A big cat", "A")).toBe("A big cat");
    expect(tokenizeNameOccurrences("", "Momo")).toBe("");
  });

  it("tokenizes non-ASCII names (\\b is ASCII-only and must not be relied on)", () => {
    expect(tokenizeNameOccurrences("小美 loves tea. Ask 小美!", "小美")).toBe(
      "{{name}} loves tea. Ask {{name}}!",
    );
    expect(tokenizeNameOccurrences("Émile said hi", "Émile")).toBe(
      "{{name}} said hi",
    );
    // Still whole-word for non-ASCII: no match inside a longer CJK run.
    expect(tokenizeNameOccurrences("小美人 is different", "小美")).toBe(
      "小美人 is different",
    );
    expect(tokenizeNameOccurrences("Émilee is different", "Émile")).toBe(
      "Émilee is different",
    );
  });
});
