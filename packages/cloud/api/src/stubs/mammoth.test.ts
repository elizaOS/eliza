/**
 * Deterministic unit coverage for the fail-loud Cloudflare Workers mammoth
 * stub. Drives the real module with no mocks: every extractor throws before
 * any DOCX work, the images proxy throws on get, and the default surface
 * re-exports the same identities. The stub has no queue, comparator, or
 * capacity.
 */

import { describe, expect, test } from "vitest";
import * as mammoth from "./mammoth";
import workerMammothSurface, {
  convertToHtml,
  convertToMarkdown,
  embedStyleMap,
  extractRawText,
  images,
} from "./mammoth";

const NOT_AVAILABLE =
  "mammoth is not available on Cloudflare Workers — DOCX text extraction runs on the Node sidecar (cloud/INFRA.md).";

const FUNCTIONS = {
  convertToHtml,
  convertToMarkdown,
  embedStyleMap,
  extractRawText,
} as const;

const FUNCTION_NAMES = Object.keys(FUNCTIONS) as Array<keyof typeof FUNCTIONS>;

const NAMED_EXPORT_KEYS = [
  "convertToHtml",
  "convertToMarkdown",
  "default",
  "embedStyleMap",
  "extractRawText",
  "images",
] as const;

const DEFAULT_KEYS = [
  "convertToHtml",
  "convertToMarkdown",
  "embedStyleMap",
  "extractRawText",
  "images",
] as const;

function expectUnavailable(fn: () => unknown, name: string): void {
  expect(fn).toThrowError(NOT_AVAILABLE);
  try {
    fn();
    throw new Error(`expected ${name} to throw`);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe(NOT_AVAILABLE);
  }
}

describe("mammoth Worker stub", () => {
  test("exports the six stand-ins and nothing else", () => {
    // Namespace key order is loader-dependent (Bun vs Vitest); membership is not.
    expect(Object.keys(mammoth).sort()).toEqual([...NAMED_EXPORT_KEYS]);
    expect(Object.getOwnPropertyNames(mammoth).sort()).toEqual([
      ...NAMED_EXPORT_KEYS,
    ]);
    expect(Object.keys(mammoth)).toHaveLength(6);
  });

  test("does not expose queue, comparator, or capacity fields", () => {
    const record = mammoth as unknown as Record<string, unknown>;
    expect("queue" in record).toBe(false);
    expect("capacity" in record).toBe(false);
    expect("comparator" in record).toBe(false);
    expect(record.queue).toBeUndefined();
    expect(record.capacity).toBeUndefined();
    expect(record.comparator).toBeUndefined();
  });

  test("function exports are distinct closures, not a shared thrower", () => {
    expect(extractRawText).not.toBe(convertToHtml);
    expect(convertToHtml).not.toBe(convertToMarkdown);
    expect(convertToMarkdown).not.toBe(embedStyleMap);
    expect(extractRawText).not.toBe(embedStyleMap);
  });

  test("default export is the same object identity as the module default", () => {
    expect(workerMammothSurface).toBe(mammoth.default);
  });

  test("default surface own keys match source order and alias the named exports", () => {
    expect(Object.keys(workerMammothSurface)).toEqual([...DEFAULT_KEYS]);
    expect(workerMammothSurface.convertToHtml).toBe(convertToHtml);
    expect(workerMammothSurface.convertToMarkdown).toBe(convertToMarkdown);
    expect(workerMammothSurface.embedStyleMap).toBe(embedStyleMap);
    expect(workerMammothSurface.extractRawText).toBe(extractRawText);
    expect(workerMammothSurface.images).toBe(images);
  });

  test("default surface is a plain extensible object, not frozen or sealed", () => {
    expect(Object.getPrototypeOf(workerMammothSurface)).toBe(Object.prototype);
    expect(Array.isArray(workerMammothSurface)).toBe(false);
    expect(Object.isFrozen(workerMammothSurface)).toBe(false);
    expect(Object.isSealed(workerMammothSurface)).toBe(false);
    expect(Object.isExtensible(workerMammothSurface)).toBe(true);
  });

  test("deleting a missing queue key on the default surface is a no-op", () => {
    const record = workerMammothSurface as unknown as Record<string, unknown>;
    expect("queue" in record).toBe(false);
    const deleted = delete record.queue;
    expect(deleted).toBe(true);
    expect(Object.keys(workerMammothSurface)).toEqual([...DEFAULT_KEYS]);
    expect(workerMammothSurface.extractRawText).toBe(extractRawText);
  });

  describe("unavailable extractors", () => {
    test.each(FUNCTION_NAMES)(
      "%s is a zero-arity function that throws the unavailable Error with no arguments",
      (name) => {
        const fn = FUNCTIONS[name];
        expect(typeof fn).toBe("function");
        expect(fn.length).toBe(0);
        expectUnavailable(fn, name);
      },
    );

    test.each(FUNCTION_NAMES)(
      "%s throws the same Error when extra arguments are supplied (no comparator or overflow handling)",
      (name) => {
        const fn = FUNCTIONS[name] as (...args: unknown[]) => never;
        expectUnavailable(
          () => fn("single-element", { overflow: true }, undefined),
          name,
        );
      },
    );

    test.each(FUNCTION_NAMES)(
      "%s throws the same Error when invoked with new (constructor path still fail-closed)",
      (name) => {
        const fn = FUNCTIONS[name] as unknown as new () => never;
        expectUnavailable(() => new fn(), name);
      },
    );

    test.each(FUNCTION_NAMES)(
      "%s keeps throwing on repeated calls (no unlock after the first miss)",
      (name) => {
        const fn = FUNCTIONS[name];
        expectUnavailable(fn, name);
        expectUnavailable(fn, name);
      },
    );
  });

  test("empty extra-argument lists and a single dummy argument take the same throw path", () => {
    const withArgs = extractRawText as (...args: unknown[]) => never;
    expectUnavailable(extractRawText, "extractRawText");
    expectUnavailable(() => extractRawText(), "extractRawText");
    expectUnavailable(() => withArgs("one"), "extractRawText");
  });

  describe("images proxy", () => {
    test("is a null-own-key object whose prototype is Object.prototype", () => {
      expect(typeof images).toBe("object");
      expect(images === null).toBe(false);
      expect(Object.getPrototypeOf(images)).toBe(Object.prototype);
      expect(Object.keys(images)).toEqual([]);
      expect(Object.getOwnPropertyNames(images)).toEqual([]);
    });

    test("throws the unavailable Error on get of a present-looking property", () => {
      expectUnavailable(() => Reflect.get(images, "img"), "images.img");
    });

    test("throws the unavailable Error on get of a missing property (no silent miss)", () => {
      expectUnavailable(
        () => Reflect.get(images, "doesNotExist"),
        "images.doesNotExist",
      );
    });

    test("`in` checks do not throw: the proxy has no `has` trap, so missing keys are false", () => {
      expect("img" in images).toBe(false);
      expect("queue" in images).toBe(false);
      expect("doesNotExist" in images).toBe(false);
    });

    test("set of a missing property succeeds (no set trap) but get still throws", () => {
      const record = images as Record<string, unknown>;
      expect(Reflect.set(record, "queue", undefined)).toBe(true);
      expect("queue" in record).toBe(true);
      expectUnavailable(() => Reflect.get(record, "queue"), "images.queue");
      expect(delete record.queue).toBe(true);
      expect("queue" in record).toBe(false);
      expect(Object.keys(images)).toEqual([]);
    });

    test("deleting a missing item is a no-op and does not unlock get", () => {
      const record = images as Record<string, unknown>;
      expect(delete record.doesNotExist).toBe(true);
      expect("doesNotExist" in record).toBe(false);
      expectUnavailable(
        () => Reflect.get(record, "doesNotExist"),
        "images.doesNotExist",
      );
    });

    test("keeps throwing on repeated get (no unlock after the first miss)", () => {
      expectUnavailable(() => Reflect.get(images, "img"), "images.img");
      expectUnavailable(() => Reflect.get(images, "img"), "images.img");
    });

    test("does not expose comparator or capacity fields via `in`", () => {
      expect("capacity" in images).toBe(false);
      expect("comparator" in images).toBe(false);
    });
  });

  test("dynamic import resolves to the same module singleton", async () => {
    const again = await import("./mammoth");
    expect(again.extractRawText).toBe(extractRawText);
    expect(again.convertToHtml).toBe(convertToHtml);
    expect(again.images).toBe(images);
    expect(again.default).toBe(workerMammothSurface);
  });
});
