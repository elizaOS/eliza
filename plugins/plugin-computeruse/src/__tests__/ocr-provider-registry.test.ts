/**
 * Unit coverage for the OCR provider registries (#9105 M1 / #9170).
 *
 * `mobile/ocr-provider.ts` owns the two seams the scene/`detect_elements`/`ocr`
 * path resolves through: the line-only `OcrProvider` registry (priority-ordered,
 * highest-available wins) and the single-slot `CoordOcrProvider` (last-call-wins,
 * the seam Windows.Media.Ocr / Apple Vision / docTR register into). The existing
 * coord-seam test registers ONE provider and checks the adapter consumes it;
 * these cases pin the registry's own multi-provider precedence, dedup, and
 * selection/throw rules.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetOcrProvidersForTests,
  type CoordOcrProvider,
  getCoordOcrProvider,
  listOcrProviders,
  type OcrProvider,
  registerCoordOcrProvider,
  registerOcrProvider,
  selectOcrProvider,
  unregisterOcrProvider,
} from "../mobile/ocr-provider.js";

const lineProvider = (
  name: string,
  priority: number,
  available = true,
): OcrProvider => ({
  name,
  priority,
  available: () => available,
  recognize: async () => ({
    lines: [],
    fullText: "",
    elapsedMs: 0,
    providerName: name,
    languagesUsed: [],
  }),
});

const coordProvider = (name: string): CoordOcrProvider => ({
  name,
  describe: async () => ({ blocks: [] }),
});

beforeEach(() => {
  _resetOcrProvidersForTests();
  registerCoordOcrProvider(null);
});

describe("OcrProvider line registry", () => {
  it("lists providers sorted by priority descending", () => {
    registerOcrProvider(lineProvider("low", 1));
    registerOcrProvider(lineProvider("high", 100));
    registerOcrProvider(lineProvider("mid", 50));
    expect(listOcrProviders().map((p) => p.name)).toEqual([
      "high",
      "mid",
      "low",
    ]);
  });

  it("dedups by name — re-registering a name replaces rather than appends", () => {
    registerOcrProvider(lineProvider("docTR", 10));
    registerOcrProvider(lineProvider("docTR", 99));
    const list = listOcrProviders();
    expect(list).toHaveLength(1);
    expect(list[0].priority).toBe(99);
  });

  it("unregisters by name", () => {
    registerOcrProvider(lineProvider("a", 1));
    registerOcrProvider(lineProvider("b", 2));
    unregisterOcrProvider("b");
    expect(listOcrProviders().map((p) => p.name)).toEqual(["a"]);
  });

  it("selects the highest-priority provider that reports available()", () => {
    registerOcrProvider(lineProvider("hi-unavailable", 100, false));
    registerOcrProvider(lineProvider("mid-available", 50, true));
    registerOcrProvider(lineProvider("lo-available", 10, true));
    expect(selectOcrProvider().name).toBe("mid-available");
  });

  it("throws when the registry is empty or nothing is available", () => {
    expect(() => selectOcrProvider()).toThrow(/No OCR provider available/);
    registerOcrProvider(lineProvider("only-unavailable", 1, false));
    expect(() => selectOcrProvider()).toThrow(/No OCR provider available/);
  });
});

describe("CoordOcrProvider single slot", () => {
  it("is empty until a provider is registered", () => {
    expect(getCoordOcrProvider()).toBeNull();
  });

  it("returns the registered provider; last call wins; null unregisters", () => {
    registerCoordOcrProvider(coordProvider("first"));
    expect(getCoordOcrProvider()?.name).toBe("first");
    registerCoordOcrProvider(coordProvider("second"));
    expect(getCoordOcrProvider()?.name).toBe("second");
    registerCoordOcrProvider(null);
    expect(getCoordOcrProvider()).toBeNull();
  });
});
