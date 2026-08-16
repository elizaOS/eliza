/**
 * Executed twin-parity contract between the two spoken-text sanitizers
 * (`packages/shared/src/spoken-text.ts` and `packages/core/src/spoken-text.ts`).
 * The duplicated per-side tables pin each behavior but cannot catch a
 * single-sided EXTENSION — adding a new hidden-block tag to one twin keeps
 * both suites green while the surfaces re-diverge (#20562). This suite closes
 * that hole by running both implementations over one corpus and asserting
 * identical output, so any one-sided change fails here regardless of shape.
 */
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
  it.each([...tagCorpus, ...generalCorpus])(
    "core and shared sanitizers speak %j identically",
    (input) => {
      expect(sharedSanitize(input)).toBe(coreSanitize(input));
    },
  );
});
