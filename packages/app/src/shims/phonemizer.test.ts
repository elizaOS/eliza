/**
 * Unit tests for the browser `phonemizer` shim. The suite drives the real
 * empty replacement module (not a mock) and records the export surface
 * `NpmPhonemizePhonemizer.tryLoad()` inspects: no `phonemize` named export
 * and no `default.phonemize`. There is no comparator, queue, removal, or
 * capacity API — the module is `export {}` only.
 */
import { describe, expect, it } from "vitest";

import * as phonemizer from "./phonemizer.js";

type PhonemizeMod = {
  phonemize?: unknown;
  default?: { phonemize?: unknown };
};

const shim = phonemizer as PhonemizeMod;

describe("phonemizer exports", () => {
  it("exposes an empty enumerable namespace: no named exports and no default", () => {
    expect(Object.keys(phonemizer)).toEqual([]);
    expect(Object.getOwnPropertyNames(phonemizer)).toEqual([]);
    expect(Object.entries(phonemizer)).toEqual([]);
  });

  it("does not own phonemize, default, or an arbitrary missing name", () => {
    expect(Object.hasOwn(phonemizer, "phonemize")).toBe(false);
    expect(Object.hasOwn(phonemizer, "default")).toBe(false);
    expect(Object.hasOwn(phonemizer, "g2p")).toBe(false);
    expect("phonemize" in phonemizer).toBe(false);
    expect("default" in phonemizer).toBe(false);
  });

  it("identifies as an ES module namespace with a null prototype", () => {
    expect(Object.getPrototypeOf(phonemizer)).toBeNull();
    expect(Object.prototype.toString.call(phonemizer)).toBe("[object Module]");
  });
});

describe("phonemizer tryLoad detection", () => {
  it("exposes no phonemize function on the namespace", () => {
    expect(shim.phonemize).toBeUndefined();
    expect(typeof shim.phonemize).toBe("undefined");
  });

  it("exposes no default object that could carry phonemize", () => {
    expect(shim.default).toBeUndefined();
    expect(shim.default?.phonemize).toBeUndefined();
  });

  it("makes the tryLoad coalesced lookup a non-function, so the loader returns null", () => {
    const phon = shim.phonemize ?? shim.default?.phonemize;
    expect(phon).toBeUndefined();
    expect(typeof phon === "function").toBe(false);
  });
});

describe("phonemizer import identity", () => {
  it("returns the same empty namespace on dynamic import as on the static binding", async () => {
    const dynamic = await import("./phonemizer.js");
    expect(dynamic).toBe(phonemizer);
    expect(Object.keys(dynamic)).toEqual([]);
    expect((dynamic as PhonemizeMod).phonemize).toBeUndefined();
    expect((dynamic as PhonemizeMod).default?.phonemize).toBeUndefined();
  });

  it("keeps the singleton on a second dynamic import", async () => {
    const first = await import("./phonemizer.js");
    const second = await import("./phonemizer.js");
    expect(first).toBe(phonemizer);
    expect(second).toBe(first);
  });
});

describe("phonemizer missing names and overflow", () => {
  it("reads a missing export as undefined rather than throwing", () => {
    expect((phonemizer as Record<string, unknown>).phonemize).toBeUndefined();
    expect((phonemizer as Record<string, unknown>).espeak).toBeUndefined();
    expect((phonemizer as Record<string, unknown>)[""]).toBeUndefined();
  });

  it("stays empty after probing many missing names: no capacity growth", () => {
    const view = phonemizer as Record<string, unknown>;
    for (let index = 0; index < 40; index += 1) {
      expect(view[`export${index}`]).toBeUndefined();
    }
    expect(Object.keys(phonemizer)).toEqual([]);
    expect(Object.getOwnPropertyNames(phonemizer)).toEqual([]);
  });
});
