// @vitest-environment node
//
// parseSegments cost benchmark (perf/chat-render-benchmarks). parseSegments
// runs on the streaming message body on every re-render of a growing turn, so
// its cost must scale ~linearly with message length — an accidental O(n²)
// (a nested region scan, a quadratic normalize) would make a long code-dump
// reply janky as it streams. This asserts (1) a generous absolute median
// budget that only a catastrophic slowdown trips on a slow CI VM, and (2) the
// deterministic teeth: the 50KB median may not exceed a small multiple of the
// 5KB median (machine speed cancels out of the ratio, so this is stable across
// runners). Node env — pure string work, no DOM.

import { describe, expect, it } from "vitest";
import { benchmark } from "../../testing/microbench";
import { parseSegments } from "./message-parser-helpers";
// Register the built-in inline widgets so `parseSegments` exercises the real
// widget-region scan (choice/followups/form/workflow/checklist), not just prose.
import "./widgets/inline-builtins";

/**
 * Build a realistic mixed message body of approximately `targetBytes`: prose
 * paragraphs interleaved with fenced code blocks and inline widget markers —
 * the same shape the parser sees for a long agent reply. Deterministic (no
 * randomness) so the benchmark is reproducible.
 */
function buildMessage(targetBytes: number): string {
  const parts: string[] = [];
  let size = 0;
  let i = 0;
  while (size < targetBytes) {
    const block =
      i % 4 === 0
        ? "Here is a paragraph of explanation that the agent streamed out to describe the next step in some detail, wrapping across a few lines of prose.\n\n"
        : i % 4 === 1
          ? "```ts\nfunction step(n: number): number {\n  return n * 2 + 1;\n}\n```\n\n"
          : i % 4 === 2
            ? "[CHOICE:disambiguate id=c" +
              i +
              "]\nyes: Yes, proceed\nno: No, cancel\n[/CHOICE]\n\n"
            : "A shorter follow-up line with some `inline code` and a trailing note.\n\n";
    parts.push(block);
    size += block.length;
    i += 1;
  }
  return parts.join("");
}

describe("parseSegments cost", () => {
  const small = buildMessage(5 * 1024);
  const large = buildMessage(50 * 1024);

  it("parses a 5KB message and a 50KB message and scales ~linearly", () => {
    // Sanity: the fixtures are the intended sizes and actually produce segments
    // (so the benchmark measures real work, not an empty fast-path).
    expect(small.length).toBeGreaterThanOrEqual(5 * 1024);
    expect(large.length).toBeGreaterThanOrEqual(50 * 1024);
    expect(parseSegments(small, false).length).toBeGreaterThan(1);
    expect(parseSegments(large, false).length).toBeGreaterThan(1);

    // Keep a live reference to the parse result so the engine can't
    // dead-code-eliminate the work being timed.
    let sink = 0;
    const smallBench = benchmark(() => {
      sink += parseSegments(small, false).length;
    });
    const largeBench = benchmark(() => {
      sink += parseSegments(large, false).length;
    });
    expect(sink).toBeGreaterThan(0);

    // (1) Absolute budget — generous, only a catastrophic regression trips it
    // on a slow shared runner. 50KB is already a very large single message.
    expect(largeBench.medianMs).toBeLessThan(50);

    // (2) Scaling teeth (deterministic): 50KB is 10× the input of 5KB. Linear
    // work lands near a 10× cost ratio; we allow up to 30× for constant
    // overheads and imperfect linearity, but a quadratic parser (~100×+) blows
    // straight past this regardless of machine speed. Guard the denominator so
    // an immeasurably-fast small parse (median 0ms) can't divide-by-zero.
    const denom = Math.max(smallBench.medianMs, 0.001);
    const ratio = largeBench.medianMs / denom;
    expect(ratio).toBeLessThan(30);
  });
});
