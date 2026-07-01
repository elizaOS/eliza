// Fuzz / hardening pass for the chat parser security boundaries. parseSegments,
// the JSONL-patch compiler, and sanitizePatchValue all consume UNTRUSTED agent
// output, so the load-bearing invariants are:
//   1. they never throw on arbitrary input,
//   2. they never pollute Object.prototype (the patch path is the attack
//      surface — agent-emitted `__proto__`/`constructor`/`prototype` keys),
//   3. containers they return have a null prototype.
// A seeded LCG drives the input generation so a failure is reproducible.

import { describe, expect, it } from "vitest";
import {
  compilePatches,
  isUiSpec,
  parseSegments,
  sanitizePatchValue,
} from "./message-parser-helpers";

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const POLLUTION_KEYS = ["__proto__", "constructor", "prototype"];
const OBJ_KEYS = ["a", "b", "x", "op", "path", "value", ...POLLUTION_KEYS];
const PRIMS = ["1", '"s"', "true", "false", "null", "-3.5", '""', "0"];

/** A random JSON *string* — parsed later so `__proto__` becomes a real own key. */
function randomJson(rng: () => number, depth: number): string {
  if (depth <= 0 || rng() < 0.4) return PRIMS[Math.floor(rng() * PRIMS.length)];
  const k = 1 + Math.floor(rng() * 4);
  if (rng() < 0.5) {
    const items: string[] = [];
    for (let i = 0; i < k; i++) items.push(randomJson(rng, depth - 1));
    return `[${items.join(",")}]`;
  }
  const entries: string[] = [];
  for (let i = 0; i < k; i++) {
    const key = OBJ_KEYS[Math.floor(rng() * OBJ_KEYS.length)];
    // Make pollution attempts potent: a hostile key carries a sentinel payload.
    const value = POLLUTION_KEYS.includes(key)
      ? '{"FUZZ_POLLUTED":true}'
      : randomJson(rng, depth - 1);
    entries.push(`${JSON.stringify(key)}:${value}`);
  }
  return `{${entries.join(",")}}`;
}

function assertNullProto(value: unknown, seen = new Set<unknown>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const v of value) assertNullProto(v, seen);
    return;
  }
  expect(Object.getPrototypeOf(value)).toBeNull();
  for (const v of Object.values(value as Record<string, unknown>)) {
    assertNullProto(v, seen);
  }
}

describe("sanitizePatchValue — fuzz", () => {
  it("never throws, returns null-proto containers, and never pollutes the global prototype", () => {
    const rng = makeRng(0xc0ffee);
    for (let i = 0; i < 2000; i++) {
      const parsed = JSON.parse(randomJson(rng, 4));
      const safe = sanitizePatchValue(parsed);
      assertNullProto(safe);
    }
    // The global Object prototype must be untouched by any of the runs.
    expect((Object.prototype as Record<string, unknown>).FUZZ_POLLUTED).toBe(
      undefined,
    );
    expect(({} as Record<string, unknown>).FUZZ_POLLUTED).toBeUndefined();
  });
});

describe("compilePatches — fuzz", () => {
  const OPS = ["add", "replace", "remove", "move", "copy", "test", "bogus"];
  const PATHS = [
    "/root",
    "/elements/n1",
    "/elements/__proto__",
    "/state",
    "/state/k",
    "/state/__proto__/FUZZ_POLLUTED",
    "/state/constructor",
    "/state/k/prototype",
    "",
    "/",
    "/unknown/branch",
  ];

  it("never throws and only ever returns a valid UiSpec or null, without polluting the prototype", () => {
    const rng = makeRng(0x1234);
    for (let i = 0; i < 2000; i++) {
      const n = Math.floor(rng() * 6);
      const patches = Array.from({ length: n }, () => ({
        op: OPS[Math.floor(rng() * OPS.length)],
        path: PATHS[Math.floor(rng() * PATHS.length)],
        value: JSON.parse(randomJson(rng, 3)),
      }));
      // biome-ignore lint/suspicious/noExplicitAny: fuzz inputs are intentionally untyped.
      const spec = compilePatches(patches as any);
      if (spec !== null) {
        expect(isUiSpec(spec)).toBe(true);
        assertNullProto((spec as { state?: unknown }).state);
      }
    }
    expect((Object.prototype as Record<string, unknown>).FUZZ_POLLUTED).toBe(
      undefined,
    );
  });
});

describe("parseSegments — fuzz", () => {
  // Nasty unicode / control chars (NUL, U+FFFF/FFFE non-characters, BOM,
  // zero-width space) built from char codes so the source stays ASCII text.
  const NASTY = ` ${String.fromCharCode(0, 0xffff, 0xfffe, 0xfeff, 0x200b)} `;
  const FRAGMENTS = [
    "[CONFIG:plug.in]",
    "[CONFIG:",
    "[TASK:aaaaaaaaaaaa]",
    "[/TASK]",
    "[CHOICE:approval id=c1]",
    "[/CHOICE]",
    "[FORM]",
    "[/FORM]",
    "[FOLLOWUPS]",
    "[/FOLLOWUPS]",
    "```json",
    "```",
    "<think>",
    "</think>",
    "`inline`",
    '{"op":"add","path":"/root","value":"n1"}',
    "\n",
    "plain words ",
    NASTY,
  ];

  it("never throws on arbitrary marker soup and always returns well-formed segments", () => {
    const rng = makeRng(0xfeed);
    const kinds = new Set([
      "text",
      "config",
      "ui-spec",
      "code",
      "widget",
      "permission",
      "analysis-xml",
    ]);
    for (let i = 0; i < 3000; i++) {
      const parts: string[] = [];
      const len = Math.floor(rng() * 12);
      for (let j = 0; j < len; j++) {
        parts.push(FRAGMENTS[Math.floor(rng() * FRAGMENTS.length)]);
      }
      const input = parts.join("");
      const analysis = rng() < 0.5;
      const segments = parseSegments(input, analysis);
      expect(Array.isArray(segments)).toBe(true);
      for (const seg of segments) {
        expect(kinds.has(seg.kind)).toBe(true);
      }
    }
  });
});
