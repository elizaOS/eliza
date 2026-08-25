/**
 * Unit coverage for the generated mobile chat-reply failure vocabulary
 * (`chat-failure-strings.generated`): ordered fragment lists, derived
 * case-insensitive regexes, shared vs platform-specific classifiers, think-tag
 * leakage, and the anti-false-green contract that genuine smoke replies do not
 * match. Drives the real generated module with no mocks.
 */
import { describe, expect, it } from "vitest";
import {
  ANDROID_FAILURE_FRAGMENTS,
  ANDROID_FULL_TURN_FAILURE_RE,
  IOS_FAILURE_FRAGMENTS,
  IOS_FULL_BUN_SMOKE_FAILURE_RE,
} from "./chat-failure-strings.generated";

const THINK_TAG_FAILURE_FRAGMENTS = [
  "<think\\b",
  "<\\/think>",
  "\\/?\\bno_think\\b",
] as const;

const EXPECTED_IOS_FAILURE_FRAGMENTS = [
  "something went wrong",
  "backend is not running",
  "local backend is not running",
  "no local backend",
  "no local model",
  "no model registered",
  "no provider",
  "connect a provider",
  "waiting for the model download",
  "timed out",
  ...THINK_TAG_FAILURE_FRAGMENTS,
] as const;

const EXPECTED_ANDROID_FAILURE_FRAGMENTS = [
  "something went wrong",
  "no local gguf",
  "no local model",
  "no model registered",
  "no provider",
  "connect a provider",
  "device_disconnected",
  "device_timeout",
  "timed out",
  "chat generation failed",
  "waiting for the model download",
  "set chat routing",
  "progress:\\s*0%",
  ...THINK_TAG_FAILURE_FRAGMENTS,
] as const;

const IOS_ONLY_PHRASES = [
  "backend is not running",
  "local backend is not running",
  "no local backend",
] as const;

const ANDROID_ONLY_PHRASES = [
  "no local gguf",
  "device_disconnected",
  "device_timeout",
  "chat generation failed",
  "set chat routing",
  "progress: 0%",
] as const;

describe("IOS_FAILURE_FRAGMENTS", () => {
  it("pins the historical iOS alternation order, including trailing think-tag fragments", () => {
    expect([...IOS_FAILURE_FRAGMENTS]).toEqual([
      ...EXPECTED_IOS_FAILURE_FRAGMENTS,
    ]);
    expect(IOS_FAILURE_FRAGMENTS).toHaveLength(13);
    expect(IOS_FAILURE_FRAGMENTS.slice(-3)).toEqual([
      ...THINK_TAG_FAILURE_FRAGMENTS,
    ]);
  });

  it("exposes a readable tuple; missing indexes are undefined, not a thrown removal", () => {
    const fragments: readonly string[] = IOS_FAILURE_FRAGMENTS;
    expect(fragments[0]).toBe("something went wrong");
    expect(fragments[12]).toBe("\\/?\\bno_think\\b");
    expect(fragments[13]).toBeUndefined();
    expect(fragments[-1]).toBeUndefined();
  });
});

describe("ANDROID_FAILURE_FRAGMENTS", () => {
  it("pins the historical Android alternation order, including trailing think-tag fragments", () => {
    expect([...ANDROID_FAILURE_FRAGMENTS]).toEqual([
      ...EXPECTED_ANDROID_FAILURE_FRAGMENTS,
    ]);
    expect(ANDROID_FAILURE_FRAGMENTS).toHaveLength(16);
    expect(ANDROID_FAILURE_FRAGMENTS.slice(-3)).toEqual([
      ...THINK_TAG_FAILURE_FRAGMENTS,
    ]);
  });

  it("shares the think-tag group and the overlapping readiness phrases with iOS", () => {
    for (const fragment of THINK_TAG_FAILURE_FRAGMENTS) {
      expect(IOS_FAILURE_FRAGMENTS).toContain(fragment);
      expect(ANDROID_FAILURE_FRAGMENTS).toContain(fragment);
    }
    for (const fragment of [
      "something went wrong",
      "no local model",
      "no model registered",
      "no provider",
      "connect a provider",
      "waiting for the model download",
      "timed out",
    ] as const) {
      expect(IOS_FAILURE_FRAGMENTS).toContain(fragment);
      expect(ANDROID_FAILURE_FRAGMENTS).toContain(fragment);
    }
  });

  it("keeps platform-only fragments off the other list", () => {
    for (const fragment of [
      "backend is not running",
      "local backend is not running",
      "no local backend",
    ] as const) {
      expect(IOS_FAILURE_FRAGMENTS).toContain(fragment);
      expect(ANDROID_FAILURE_FRAGMENTS).not.toContain(fragment);
    }
    for (const fragment of [
      "no local gguf",
      "device_disconnected",
      "device_timeout",
      "chat generation failed",
      "set chat routing",
      "progress:\\s*0%",
    ] as const) {
      expect(ANDROID_FAILURE_FRAGMENTS).toContain(fragment);
      expect(IOS_FAILURE_FRAGMENTS).not.toContain(fragment);
    }
  });
});

describe("derived failure regexes", () => {
  it("builds each regex by joining fragments with | and the i flag only", () => {
    expect(IOS_FULL_BUN_SMOKE_FAILURE_RE.source).toBe(
      IOS_FAILURE_FRAGMENTS.join("|"),
    );
    expect(ANDROID_FULL_TURN_FAILURE_RE.source).toBe(
      ANDROID_FAILURE_FRAGMENTS.join("|"),
    );
    expect(IOS_FULL_BUN_SMOKE_FAILURE_RE.flags).toBe("i");
    expect(ANDROID_FULL_TURN_FAILURE_RE.flags).toBe("i");
    expect(IOS_FULL_BUN_SMOKE_FAILURE_RE.global).toBe(false);
    expect(ANDROID_FULL_TURN_FAILURE_RE.global).toBe(false);
    expect(IOS_FULL_BUN_SMOKE_FAILURE_RE.sticky).toBe(false);
    expect(ANDROID_FULL_TURN_FAILURE_RE.sticky).toBe(false);
  });

  it("does not advance lastIndex across repeated .test calls (no /g)", () => {
    const haystack = "Something went wrong";
    expect(IOS_FULL_BUN_SMOKE_FAILURE_RE.test(haystack)).toBe(true);
    expect(IOS_FULL_BUN_SMOKE_FAILURE_RE.lastIndex).toBe(0);
    expect(IOS_FULL_BUN_SMOKE_FAILURE_RE.test(haystack)).toBe(true);
    expect(ANDROID_FULL_TURN_FAILURE_RE.test(haystack)).toBe(true);
    expect(ANDROID_FULL_TURN_FAILURE_RE.lastIndex).toBe(0);
    expect(ANDROID_FULL_TURN_FAILURE_RE.test(haystack)).toBe(true);
  });
});

describe("IOS_FULL_BUN_SMOKE_FAILURE_RE", () => {
  it("classifies every iOS fragment as a failure, including wrapped haystacks", () => {
    const haystacks: Record<(typeof IOS_FAILURE_FRAGMENTS)[number], string> = {
      "something went wrong": "Error: something went wrong while starting",
      "backend is not running": "The backend is not running on :3000",
      "local backend is not running": "Local backend is not running",
      "no local backend": "no local backend configured",
      "no local model": "no local model is loaded",
      "no model registered": "no model registered yet",
      "no provider": "no provider available",
      "connect a provider": "Please connect a provider first",
      "waiting for the model download": "waiting for the model download (1/3)",
      "timed out": "request timed out after 30s",
      "<think\\b": "<think>chain of thought</think>",
      "<\\/think>": "hidden </think> leak",
      "\\/?\\bno_think\\b": "leaked no_think marker",
    };
    for (const fragment of IOS_FAILURE_FRAGMENTS) {
      expect(IOS_FULL_BUN_SMOKE_FAILURE_RE.test(haystacks[fragment])).toBe(
        true,
      );
    }
  });

  it("is case-insensitive", () => {
    expect(IOS_FULL_BUN_SMOKE_FAILURE_RE.test("SOMETHING WENT WRONG")).toBe(
      true,
    );
    expect(
      IOS_FULL_BUN_SMOKE_FAILURE_RE.test("LOCAL BACKEND IS NOT RUNNING"),
    ).toBe(true);
    expect(IOS_FULL_BUN_SMOKE_FAILURE_RE.test("</THINK>")).toBe(true);
  });

  it("does not classify an empty string or a genuine smoke reply as a failure", () => {
    expect(IOS_FULL_BUN_SMOKE_FAILURE_RE.test("")).toBe(false);
    expect(IOS_FULL_BUN_SMOKE_FAILURE_RE.test("ios smoke model works")).toBe(
      false,
    );
    expect(
      IOS_FULL_BUN_SMOKE_FAILURE_RE.test("hello in one short sentence"),
    ).toBe(false);
  });

  it("does not treat Android-only failure renders as iOS failures", () => {
    for (const phrase of ANDROID_ONLY_PHRASES) {
      expect(IOS_FULL_BUN_SMOKE_FAILURE_RE.test(phrase)).toBe(false);
    }
  });

  it("honors think-tag word boundaries and does not match timeout as timed out", () => {
    expect(IOS_FULL_BUN_SMOKE_FAILURE_RE.test("<think>")).toBe(true);
    expect(IOS_FULL_BUN_SMOKE_FAILURE_RE.test("<think foo>")).toBe(true);
    expect(IOS_FULL_BUN_SMOKE_FAILURE_RE.test("<thinking>")).toBe(false);
    expect(IOS_FULL_BUN_SMOKE_FAILURE_RE.test("no_think")).toBe(true);
    expect(IOS_FULL_BUN_SMOKE_FAILURE_RE.test("/no_think")).toBe(true);
    expect(IOS_FULL_BUN_SMOKE_FAILURE_RE.test("xno_think")).toBe(false);
    expect(IOS_FULL_BUN_SMOKE_FAILURE_RE.test("no_thinks")).toBe(false);
    expect(IOS_FULL_BUN_SMOKE_FAILURE_RE.test("timed out")).toBe(true);
    expect(IOS_FULL_BUN_SMOKE_FAILURE_RE.test("timeout")).toBe(false);
    expect(IOS_FULL_BUN_SMOKE_FAILURE_RE.test("device_timeout")).toBe(false);
  });

  it("lets the earliest matching alternative win when phrases overlap", () => {
    expect(
      IOS_FULL_BUN_SMOKE_FAILURE_RE.exec("backend is not running")?.[0],
    ).toBe("backend is not running");
    expect(
      IOS_FULL_BUN_SMOKE_FAILURE_RE.exec("local backend is not running")?.[0],
    ).toBe("local backend is not running");
    expect(
      IOS_FULL_BUN_SMOKE_FAILURE_RE.exec("The backend is not running now")?.[0],
    ).toBe("backend is not running");
    expect(IOS_FULL_BUN_SMOKE_FAILURE_RE.exec("no local backend")?.[0]).toBe(
      "no local backend",
    );
  });
});

describe("ANDROID_FULL_TURN_FAILURE_RE", () => {
  it("classifies every Android fragment as a failure", () => {
    const haystacks: Record<
      (typeof ANDROID_FAILURE_FRAGMENTS)[number],
      string
    > = {
      "something went wrong": "Something went wrong",
      "no local gguf": "no local gguf on disk",
      "no local model": "no local model",
      "no model registered": "no model registered",
      "no provider": "no provider",
      "connect a provider": "connect a provider",
      device_disconnected: "device_disconnected",
      device_timeout: "device_timeout",
      "timed out": "timed out",
      "chat generation failed": "chat generation failed",
      "waiting for the model download": "waiting for the model download",
      "set chat routing": "set chat routing",
      "progress:\\s*0%": "progress: 0%",
      "<think\\b": "<think>leak</think>",
      "<\\/think>": "</think>",
      "\\/?\\bno_think\\b": "/no_think",
    };
    for (const fragment of ANDROID_FAILURE_FRAGMENTS) {
      expect(ANDROID_FULL_TURN_FAILURE_RE.test(haystacks[fragment])).toBe(true);
    }
  });

  it("matches progress:\\s*0% on zero-or-more whitespace and rejects nearby percents", () => {
    expect(ANDROID_FULL_TURN_FAILURE_RE.test("progress:0%")).toBe(true);
    expect(ANDROID_FULL_TURN_FAILURE_RE.test("progress: 0%")).toBe(true);
    expect(ANDROID_FULL_TURN_FAILURE_RE.test("progress:\t0%")).toBe(true);
    expect(ANDROID_FULL_TURN_FAILURE_RE.test("progress:  0%")).toBe(true);
    expect(
      ANDROID_FULL_TURN_FAILURE_RE.exec("progress: 0% remaining")?.[0],
    ).toBe("progress: 0%");
    expect(ANDROID_FULL_TURN_FAILURE_RE.test("progress: 10%")).toBe(false);
    expect(ANDROID_FULL_TURN_FAILURE_RE.test("progress:00%")).toBe(false);
    expect(ANDROID_FULL_TURN_FAILURE_RE.test("progress: 0")).toBe(false);
  });

  it("does not classify an empty string or a genuine smoke reply as a failure", () => {
    expect(ANDROID_FULL_TURN_FAILURE_RE.test("")).toBe(false);
    expect(ANDROID_FULL_TURN_FAILURE_RE.test("android smoke model works")).toBe(
      false,
    );
  });

  it("does not treat iOS-only backend-down renders as Android failures", () => {
    for (const phrase of IOS_ONLY_PHRASES) {
      expect(ANDROID_FULL_TURN_FAILURE_RE.test(phrase)).toBe(false);
    }
  });

  it("classifies device disconnect and chat-generation-failed as failures", () => {
    expect(ANDROID_FULL_TURN_FAILURE_RE.test("device_disconnected")).toBe(true);
    expect(ANDROID_FULL_TURN_FAILURE_RE.test("DEVICE_DISCONNECTED")).toBe(true);
    expect(ANDROID_FULL_TURN_FAILURE_RE.test("chat generation failed")).toBe(
      true,
    );
    expect(ANDROID_FULL_TURN_FAILURE_RE.test("timeout")).toBe(false);
  });
});
