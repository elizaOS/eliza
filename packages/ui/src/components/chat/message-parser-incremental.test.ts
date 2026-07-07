// @vitest-environment node
//
// Correctness + work bound for the incremental streaming parser (#15280). The
// frame-by-frame differential — feed every growing prefix to BOTH the
// incremental wrapper (threading its cache) and the pure full parser and assert
// `toEqual` at every frame across 1/3/random chunkings — is the real proof that
// the normalize/parse seam rules never diverge from a full parse. Pure string
// work; the built-in widgets are registered so the widget passes run for real.

import { describe, expect, it } from "vitest";
import {
  MAX_DISPLAY_LEN,
  normalizeDisplayCore,
  parserWork,
  parseSegments,
  resetParserWork,
  type Segment,
} from "./message-parser-helpers";
import {
  computeSafeNormCut,
  parseSegmentsStreaming,
  type StreamingParseCache,
} from "./message-parser-incremental";
// Register the built-in inline widgets so the widget-region scan runs for real.
import "./widgets/inline-builtins";

/** Deterministic small-step PRNG for reproducible random chunk sizes. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Split `text` into cumulative prefixes at the given chunk boundaries. */
function prefixesByChunk(text: string, chunk: number): string[] {
  const out: string[] = [];
  for (let i = chunk; i < text.length; i += chunk) out.push(text.slice(0, i));
  out.push(text);
  return out;
}

function prefixesByRandom(text: string, seed: number): string[] {
  const rng = makeRng(seed);
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    i = Math.min(text.length, i + 1 + Math.floor(rng() * 5));
    out.push(text.slice(0, i));
  }
  return out;
}

/**
 * Stream every prefix through the incremental wrapper, threading the cache, and
 * assert each frame equals the full parse of that prefix.
 */
function assertDifferential(analysisMode: boolean, prefixes: string[]): void {
  let cache: StreamingParseCache | null = null;
  for (const prefix of prefixes) {
    const { segments, cache: next } = parseSegmentsStreaming(
      prefix,
      analysisMode,
      cache,
    );
    cache = next;
    const expected = parseSegments(prefix, analysisMode);
    expect(
      segments,
      `prefix len ${prefix.length}: ${JSON.stringify(prefix)}`,
    ).toEqual(expected);
  }
}

const FIXTURES: Array<{ name: string; text: string; analysis?: boolean }> = [
  {
    name: "pure multi-line prose",
    text: "Here is the first paragraph of the reply.\nIt continues onto a second line.\n\nAnd a third paragraph closes it out with a final sentence.",
  },
  {
    name: "prose + fenced code completing over frames",
    text: "Let me show you the helper.\n\n```ts\nfunction add(a: number, b: number): number {\n  return a + b;\n}\n```\n\nThat is the whole thing.",
  },
  {
    name: "two fenced blocks with prose between",
    text: "First:\n\n```js\nconst a = 1;\n```\n\nSecond one here:\n\n```py\nx = 2\n```\n\nDone.",
  },
  {
    name: "CHOICE widget block",
    text: "Pick one:\n\n[CHOICE:approval id=c1]\nyes=Approve\nno=Reject\n[/CHOICE]\n\nThanks.",
  },
  {
    // Explicit `id` — a form without one gets a random UUID per parse, so the
    // full parser is nondeterministic and can't be diffed against (the
    // incremental parser is strictly better there: it freezes the id once the
    // region finalizes; see the stable-id test below).
    name: "FORM widget block",
    text: 'Fill this in:\n\n[FORM]\n{"id":"signup","fields":[{"name":"email","type":"text"}]}\n[/FORM]\n\nSubmit when ready.',
  },
  {
    name: "FOLLOWUPS widget block",
    text: "Anything else?\n\n[FOLLOWUPS id=f1]\nreply=Reply now\nnav=Open settings\n[/FOLLOWUPS]\n\nOK.",
  },
  {
    name: "JSONL patch block with internal blank line",
    text: 'Applying a spec:\n\n{"op":"add","path":"/root","value":"panel"}\n\n{"op":"add","path":"/elements/panel","value":{"type":"text"}}\n\nDone patching.',
  },
  {
    name: "CONFIG marker then prose",
    text: "Configure it:\n\n[CONFIG:@elizaos/plugin-discord]\n\nThat sets up Discord.",
  },
  {
    name: "permission card (prose + fenced JSON)",
    text: 'I need camera access to do that.\n\n```json\n{"action":"permission_request","permission":"camera","reason":"scan a QR code","feature":"scanner.qr.read"}\n```',
  },
  {
    name: "stage direction completing mid-stream",
    text: "Hi there *smiles warmly* it is good to see you again today my friend.",
  },
  {
    name: "underscore stage direction mid-stream",
    text: "Well _shrugs_ I am not entirely sure but here is my best guess for you.",
  },
  {
    name: "hidden think block closing mid-stream",
    text: "<think>\nThe user wants the capital.\nParis is correct.\n</think>\nThe capital of France is Paris.",
  },
  {
    name: "markdown link in prose",
    text: "See the [docs page](https://example.com/docs) for the full guide and then\ncome back here to continue with the next step in the process.",
  },
  {
    name: "unterminated fence to EOF",
    text: "Here is some code that never closes:\n\n```ts\nfunction oops() {\n  return 1;",
  },
  {
    name: "open paren at line end + indented continuation",
    text: "Consider the function (\n  which spans lines\n) and note it carefully please.",
  },
  {
    name: "trailing comma and spaced comma across frames",
    text: "First item , second item, and a third item , plus a closing note here.",
  },
  {
    name: "fence then widget then prose",
    text: "Steps:\n\n```sh\nnpm i\n```\n\nNow choose:\n\n[CHOICE:next id=c2]\ngo=Go\nstop=Stop\n[/CHOICE]\n\nAll set.",
  },
  {
    name: "TASK block with uuid",
    text: "Working on it:\n\n[TASK:0123abcd-1234-5678-9abc-deadbeefcafe]Build the thing[/TASK]\n\nWill update you.",
  },
  {
    name: "CHECKLIST block",
    text: 'Plan:\n\n[CHECKLIST]\n{"title":"Steps","items":[{"content":"first"},{"content":"second"}]}\n[/CHECKLIST]\n\nStarting now.',
  },
  {
    name: "BACKGROUND bare marker",
    text: "Setting the mood.\n\n[BACKGROUND]\n\nEnjoy the ambiance while we work.",
  },
  {
    name: "two hidden think blocks then answer",
    text: "<think>step one reasoning</think>\nPartial answer.\n<think>step two reasoning</think>\nFinal answer is 42.",
  },
  {
    name: "CONFIG mid-line with trailing prose",
    text: "Enable it here [CONFIG:@elizaos/plugin-slack] and it starts working right away for you.",
  },
  {
    name: "inline code kept in prose",
    text: "Run the `build` command and then the `test` command to verify everything works end to end.",
  },
  {
    name: "fence, patch, widget, prose mixed",
    text: 'Overview.\n\n```json\n{"note":"not a spec"}\n```\n\n{"op":"add","path":"/root","value":"card"}\n\n[CHOICE:go id=c9]\ny=Yes\nn=No\n[/CHOICE]\n\nEnd.',
  },
  {
    name: "analysis thought stream",
    analysis: true,
    text: "<thought>\nI should greet them first.\n</thought>\n<response>\nHello, how can I help?\n</response>",
  },
];

describe("parseSegmentsStreaming differential (byte-identical to full parse)", () => {
  for (const { name, text, analysis } of FIXTURES) {
    for (const chunk of [1, 3]) {
      it(`${name} — ${chunk}-char chunks`, () => {
        assertDifferential(analysis ?? false, prefixesByChunk(text, chunk));
      });
    }
    for (const seed of [1, 7, 99]) {
      it(`${name} — random chunks seed ${seed}`, () => {
        assertDifferential(analysis ?? false, prefixesByRandom(text, seed));
      });
    }
  }
});

describe("normalize seam locality (computeSafeNormCut)", () => {
  const rawCases = [
    "hello *smiles* world\nnext line here\nand more",
    "Consider (\n  a paren\n) then\ndone here now",
    "<think>reason</think>\nanswer here\nmore answer",
    "line one,\nline two ,\nline three)\nline four",
    "_italic start_\nplain line\nanother plain line here",
    "```ts\ncode\n```\nafter fence line\nfinal line",
    "trailing spaces here   \nnext content line\nthird content line",
    "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np",
  ];
  it("split at the computed cut is byte-identical to a whole normalize", () => {
    for (const raw of rawCases) {
      // Walk every growing prefix, advancing the cut monotonically as the real
      // wrapper does, and check the clean-seam identity at each step.
      let fromCut = 0;
      for (let len = 1; len <= raw.length; len++) {
        const prefix = raw.slice(0, len);
        const cut = computeSafeNormCut(prefix, fromCut);
        expect(cut, `raw=${JSON.stringify(prefix)}`).toBeGreaterThanOrEqual(
          fromCut,
        );
        const spliced =
          normalizeDisplayCore(prefix.slice(0, cut)) +
          normalizeDisplayCore(prefix.slice(cut));
        expect(spliced, `cut=${cut} raw=${JSON.stringify(prefix)}`).toBe(
          normalizeDisplayCore(prefix),
        );
        fromCut = cut;
      }
    }
  });
});

/** ~targetBytes of realistic mixed reply with short lines (no degenerate pins). */
function buildStreamBody(targetBytes: number): string {
  const parts: string[] = [];
  let size = 0;
  let i = 0;
  while (size < targetBytes) {
    const block =
      i % 4 === 0
        ? "A short paragraph line that the agent streamed to describe a step.\nWrapping onto a second line and a third short line for good measure.\n\n"
        : i % 4 === 1
          ? "```ts\nfunction step(n) {\n  return n * 2;\n}\n```\n\n"
          : i % 4 === 2
            ? `[CHOICE:pick id=c${i}]\nyes=Yes go ahead\nno=No stop now\n[/CHOICE]\n\n`
            : "A follow-up line with a `token` and a closing note on the step.\n\n";
    parts.push(block);
    size += block.length;
    i += 1;
  }
  return parts.join("");
}

describe("work bound (O(delta), not O(N·L))", () => {
  it("streams a ~100KB mixed reply in 64B chunks with near-linear scanned chars", () => {
    const body = buildStreamBody(100 * 1024);
    const total = body.length;
    const prefixes = prefixesByChunk(body, 64);

    resetParserWork();
    let cache: StreamingParseCache | null = null;
    for (const prefix of prefixes) {
      const res = parseSegmentsStreaming(prefix, false, cache);
      cache = res.cache;
    }
    const incrementalScanned =
      parserWork.regionScanChars + parserWork.normalizedChars;

    // Baseline: the same stream through the pure full parser every frame.
    resetParserWork();
    for (const prefix of prefixes) parseSegments(prefix, false);
    const baselineScanned =
      parserWork.regionScanChars + parserWork.normalizedChars;

    // Incremental must be O(L): a small multiple of the final length, and a
    // large fraction below the quadratic baseline.
    expect(incrementalScanned).toBeLessThan(20 * total);
    expect(incrementalScanned).toBeLessThan(baselineScanned / 10);
  });

  it("keeps full parses rare across the stream", () => {
    const body = buildStreamBody(40 * 1024);
    const prefixes = prefixesByChunk(body, 64);
    resetParserWork();
    let cache: StreamingParseCache | null = null;
    for (const prefix of prefixes) {
      const res = parseSegmentsStreaming(prefix, false, cache);
      cache = res.cache;
    }
    expect(parserWork.fullParses).toBeLessThan(20);
    expect(parserWork.incrementalParses).toBeGreaterThan(prefixes.length - 20);
  });
});

describe("trigger fast path (criterion 4)", () => {
  it("prose-only stream never touches the region scan", () => {
    const body =
      "This is a long prose reply with no trigger characters at all just words.\n".repeat(
        200,
      );
    const prefixes = prefixesByChunk(body, 32);
    resetParserWork();
    let cache: StreamingParseCache | null = null;
    for (const prefix of prefixes) {
      const res = parseSegmentsStreaming(prefix, false, cache);
      cache = res.cache;
      expect(res.segments.length).toBe(1);
      expect(res.segments[0].kind).toBe("text");
    }
    expect(parserWork.regionScanChars).toBe(0);
  });
});

describe("stable id under streaming (better than a full re-parse)", () => {
  it("freezes an auto-generated form id once the region finalizes", () => {
    const text =
      'Form:\n\n[FORM]\n{"fields":[{"name":"email","type":"text"}]}\n[/FORM]\n\nafter text here to seal the region';
    let cache: StreamingParseCache | null = null;
    const ids: string[] = [];
    for (const prefix of prefixesByChunk(text, 1)) {
      const { segments, cache: next } = parseSegmentsStreaming(
        prefix,
        false,
        cache,
      );
      cache = next;
      const form = segments.find((s: Segment) => s.kind === "widget");
      if (form && form.kind === "widget") {
        const data = form.data as { form?: { id?: string } };
        if (data.form?.id) ids.push(data.form.id);
      }
    }
    // Once the form appears its id never changes across the rest of the stream —
    // so the rendered widget's React key is stable and it never remounts.
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids.slice(Math.floor(ids.length / 2))).size).toBe(1);
  });
});

describe("prefix-change fallback", () => {
  it("a non-append edit falls back to a fresh full parse", () => {
    const first = "Hello there\n\n```ts\nconst a = 1;\n```\n\nBye now";
    const edited = "HELLO there\n\n```ts\nconst a = 1;\n```\n\nBye now";
    let cache: StreamingParseCache | null = null;
    for (const p of prefixesByChunk(first, 3)) {
      cache = parseSegmentsStreaming(p, false, cache).cache;
    }
    const { segments } = parseSegmentsStreaming(edited, false, cache);
    expect(segments).toEqual(parseSegments(edited, false));
  });

  it("shrinking text (retraction) falls back correctly", () => {
    const full = "Reply\n\n```ts\ncode\n```\n\ntail";
    let cache: StreamingParseCache | null = null;
    for (const p of prefixesByChunk(full, 2)) {
      cache = parseSegmentsStreaming(p, false, cache).cache;
    }
    const shorter = "Reply\n\n```ts\nco";
    const { segments } = parseSegmentsStreaming(shorter, false, cache);
    expect(segments).toEqual(parseSegments(shorter, false));
  });

  it("full-rebuilds on the frame that crosses the display normalizer cap", () => {
    const seed = "seed line\nnext line\n";
    const before =
      seed +
      "stable line\n".repeat(
        Math.floor(
          (MAX_DISPLAY_LEN - seed.length - 64) / "stable line\n".length,
        ),
      );
    const after = `${before}${"tail ".repeat(40)}`;

    let cache: StreamingParseCache | null = null;
    cache = parseSegmentsStreaming(seed, false, cache).cache;
    cache = parseSegmentsStreaming(before, false, cache).cache;

    const { segments } = parseSegmentsStreaming(after, false, cache);

    expect(after.length).toBeGreaterThanOrEqual(MAX_DISPLAY_LEN);
    expect(segments).toEqual(parseSegments(after, false));
    expect(segments[0]).toMatchObject({
      kind: "text",
      text: after.slice(0, MAX_DISPLAY_LEN).trim(),
    });
  });
});

describe("identity + boundary integrity", () => {
  it("returns the same segment array reference for an unchanged text", () => {
    const text = "Hi\n\n```ts\nx\n```\n\nbye";
    const first = parseSegmentsStreaming(text, false, null);
    const second = parseSegmentsStreaming(text, false, first.cache);
    expect(second.segments).toBe(first.segments);
  });

  it("emits a closed region exactly once on the frame it completes", () => {
    const text = "Look:\n\n```ts\nconst a = 1;\n```\n\nafter";
    let cache: StreamingParseCache | null = null;
    let sawCode = false;
    for (const prefix of prefixesByChunk(text, 1)) {
      const { segments, cache: next } = parseSegmentsStreaming(
        prefix,
        false,
        cache,
      );
      cache = next;
      const codeSegs = segments.filter((s: Segment) => s.kind === "code");
      expect(codeSegs.length).toBeLessThanOrEqual(1);
      if (codeSegs.length === 1) sawCode = true;
      expect(segments).toEqual(parseSegments(prefix, false));
    }
    expect(sawCode).toBe(true);
  });
});
