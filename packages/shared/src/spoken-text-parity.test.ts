/**
 * Executed twin-parity contract between the two spoken-text sanitizers
 * (`packages/shared/src/spoken-text.ts` and `packages/core/src/spoken-text.ts`).
 * The duplicated per-side tables pin each behavior but cannot catch a
 * single-sided EXTENSION — adding a new hidden-block tag to one twin keeps
 * both suites green while the surfaces re-diverge (#20562). This suite closes
 * that hole by running both implementations over one corpus and asserting
 * identical output, so any one-sided change fails here regardless of shape.
 */
import { readFileSync } from "node:fs";

import { sanitizeSpeechText as coreSanitize } from "@elizaos/core";
import { describe, expect, it } from "vitest";

import { sanitizeSpeechText as sharedSanitize } from "./spoken-text";

const hiddenBlockTags = [
  "think",
  "analysis",
  "reasoning",
  "tool_call",
  "tool_calls",
  "tool",
  "tools",
] as const;

const tagCorpus = hiddenBlockTags.flatMap((tag) => [
  `Visible. <${tag}>private payload</${tag}> Continue.`,
  `Visible. <${tag}>private payload`,
  `Visible. <${tag} private payload`,
]);

// Tags NEITHER implementation strips today. Both currently leak them the same
// way, so parity holds — and the moment ONE side starts stripping such a tag,
// its arms diverge and fail here. This is what catches a single-sided
// EXTENSION for a tag no enumerated corpus could anticipate by name alone
// (#20569 review): a representative battery of plausible future hidden-block
// spellings, each in closed/unterminated/truncated-opener form.
const unknownTagProbes = [
  "summary",
  "scratchpad",
  "reflection",
  "plan",
  "hidden",
  "internal",
  "critique",
  "draft",
].flatMap((tag) => [
  `Visible. <${tag}>maybe hidden</${tag}> Continue.`,
  `Visible. <${tag}>maybe hidden`,
  `Visible. <${tag} maybe hidden`,
]);

const generalCorpus = [
  // Repeated punctuation, ASCII and CJK, incl. mixed runs.
  "*whispers* Wait!!! (pause) Are you sure??",
  "Yes....?!",
  "真的吗！！！",
  "标题：：：内容。。。",
  // Fenced code, inline code, links, URLs.
  "Use `bun test`. ```ts\nconst secret = true;\n``` Done.",
  "Open [the docs](https://example.com/docs) at https://x.test.",
  // Mixed multi-block sequences, including distinct adjacent tags.
  "A <think>x</think> mid <analysis>y</analysis> B.",
  "Lead. <tool_calls><invoke name='x'/></tool_calls> Trail. <reasoning>tail",
  // Closed block followed by a truncated opener tail — the only shape that
  // exercises the closed-pass -> truncated-opener-pass sequencing.
  "A <think>x</think> B <tool tail",
  // Plain prose control and empty-ish inputs.
  "Nothing hidden here, just speech.",
  "   ",
];

describe("spoken-text twin parity (#20562)", () => {
  it.each([...tagCorpus, ...unknownTagProbes, ...generalCorpus])(
    "core and shared sanitizers speak %j identically",
    (input) => {
      expect(sharedSanitize(input)).toBe(coreSanitize(input));
    },
  );

  it("keeps the two hidden-block alternations textually identical at the source level", () => {
    // Belt to the probes' suspenders: behavioral probes catch an extension
    // whose tag appears in the corpus; this catches ANY tag-list edit on
    // either side, by name, before a behavioral case exists for it. The two
    // files are twins by contract (#20519) — their strip-pass alternations
    // must not drift even in ways the current corpus cannot observe.
    const read = (path: string) =>
      readFileSync(new URL(path, import.meta.url), "utf8");
    const alternations = (source: string) =>
      [...source.matchAll(/<\\?\(\??:?(think[^)]*)\)/g)].map(
        (match) => match[1],
      );
    const sharedSource = read("./spoken-text.ts");
    const coreSource = read("../../core/src/spoken-text.ts");
    const sharedAlternations = alternations(sharedSource);
    const coreAlternations = alternations(coreSource);
    expect(sharedAlternations.length).toBeGreaterThanOrEqual(2);
    expect(sharedAlternations).toEqual(coreAlternations);
  });
});
