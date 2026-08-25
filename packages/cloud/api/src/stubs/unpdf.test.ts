/**
 * Deterministic unit coverage for the workerd-safe unpdf stub. Drives the
 * real module with no mocks: every named export and every default-surface
 * method throws the sidecar-not-worker Error before any PDF work. The stub
 * has no queue, comparator, or capacity.
 */

import { describe, expect, test } from "vitest";
import * as unpdf from "./unpdf";
import workerUnpdfSurface, {
  definePDFJSModule,
  extractImages,
  extractText,
  getDocumentProxy,
  getMeta,
  getResolvedPDFJS,
  renderPageAsImage,
} from "./unpdf";

const NOT_AVAILABLE =
  "unpdf is not available on Cloudflare Workers — PDF text extraction runs on the Node sidecar (cloud/INFRA.md).";

const NAMED_EXPORTS = {
  definePDFJSModule,
  extractImages,
  extractText,
  getDocumentProxy,
  getMeta,
  getResolvedPDFJS,
  renderPageAsImage,
} as const;

const NAMED_EXPORT_NAMES = [
  "definePDFJSModule",
  "extractImages",
  "extractText",
  "getDocumentProxy",
  "getMeta",
  "getResolvedPDFJS",
  "renderPageAsImage",
] as const;

type NamedExport = (typeof NAMED_EXPORT_NAMES)[number];

const DEFAULT_KEYS = [
  "definePDFJSModule",
  "extractImages",
  "extractText",
  "getDocumentProxy",
  "getMeta",
  "getResolvedPDFJS",
  "renderPageAsImage",
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

describe("unpdf Worker stub", () => {
  test("module namespace exposes the seven throwers plus default, sorted", () => {
    expect(Object.keys(unpdf).sort()).toEqual([
      "default",
      ...NAMED_EXPORT_NAMES,
    ]);
    expect(Object.keys(unpdf)).toHaveLength(8);
  });

  test("named exports are the same functions as the namespace properties", () => {
    expect(typeof unpdf.definePDFJSModule).toBe("function");
    expect(unpdf.definePDFJSModule).toBe(definePDFJSModule);
    expect(typeof unpdf.extractImages).toBe("function");
    expect(unpdf.extractImages).toBe(extractImages);
    expect(typeof unpdf.extractText).toBe("function");
    expect(unpdf.extractText).toBe(extractText);
    expect(typeof unpdf.getDocumentProxy).toBe("function");
    expect(unpdf.getDocumentProxy).toBe(getDocumentProxy);
    expect(typeof unpdf.getMeta).toBe("function");
    expect(unpdf.getMeta).toBe(getMeta);
    expect(typeof unpdf.getResolvedPDFJS).toBe("function");
    expect(unpdf.getResolvedPDFJS).toBe(getResolvedPDFJS);
    expect(typeof unpdf.renderPageAsImage).toBe("function");
    expect(unpdf.renderPageAsImage).toBe(renderPageAsImage);
  });

  test("default export is the worker surface object, not a thrower", () => {
    expect(workerUnpdfSurface).toBe(unpdf.default);
    expect(typeof workerUnpdfSurface).toBe("object");
    expect(workerUnpdfSurface).not.toBeNull();
    expect(Object.getPrototypeOf(workerUnpdfSurface)).toBe(Object.prototype);
    expect(Array.isArray(workerUnpdfSurface)).toBe(false);
  });

  test("default surface own keys are the seven throwers in source order", () => {
    expect(Object.keys(workerUnpdfSurface)).toEqual([...DEFAULT_KEYS]);
    expect(Object.getOwnPropertyNames(workerUnpdfSurface)).toEqual([
      ...DEFAULT_KEYS,
    ]);
  });

  test("default surface methods are the same identities as the named exports", () => {
    for (const name of NAMED_EXPORT_NAMES) {
      expect(workerUnpdfSurface[name]).toBe(NAMED_EXPORTS[name]);
    }
  });

  test("throwers are distinct closures that share one error message, not one function", () => {
    expect(extractText).not.toBe(getDocumentProxy);
    expect(extractText).not.toBe(definePDFJSModule);
    expect(extractImages).not.toBe(renderPageAsImage);
    expect(getMeta).not.toBe(getResolvedPDFJS);
  });

  test("does not expose queue, comparator, or capacity fields", () => {
    const record = workerUnpdfSurface as unknown as Record<string, unknown>;
    expect("queue" in record).toBe(false);
    expect("capacity" in record).toBe(false);
    expect("comparator" in record).toBe(false);
    expect(record.queue).toBeUndefined();
    expect(record.capacity).toBeUndefined();
    expect(record.comparator).toBeUndefined();
  });

  test("reads a missing export as undefined rather than throwing", () => {
    const view = unpdf as unknown as Record<string, unknown>;
    expect(view.parsePdf).toBeUndefined();
    expect(view.phonemize).toBeUndefined();
    expect(view[""]).toBeUndefined();
    expect("queue" in view).toBe(false);
  });

  test("deleting a missing queue key is a no-op and leaves the seven methods", () => {
    const record = workerUnpdfSurface as unknown as Record<string, unknown>;
    expect("queue" in record).toBe(false);
    const deleted = delete record.queue;
    expect(deleted).toBe(true);
    expect(Object.keys(workerUnpdfSurface)).toEqual([...DEFAULT_KEYS]);
    expect(workerUnpdfSurface.extractText).toBe(extractText);
  });

  test("is not frozen or sealed", () => {
    expect(Object.isFrozen(workerUnpdfSurface)).toBe(false);
    expect(Object.isSealed(workerUnpdfSurface)).toBe(false);
    expect(Object.isExtensible(workerUnpdfSurface)).toBe(true);
  });

  test("dynamic import resolves to the same module singleton", async () => {
    const again = await import("./unpdf");
    expect(again.extractText).toBe(extractText);
    expect(again.default).toBe(workerUnpdfSurface);
    expect(again).toBe(unpdf);
  });
});

describe("unavailable throwers", () => {
  test.each(NAMED_EXPORT_NAMES)(
    "%s is a function that throws the unavailable Error with no arguments",
    (name: NamedExport) => {
      const fn = NAMED_EXPORTS[name];
      expect(typeof fn).toBe("function");
      expectUnavailable(fn, name);
    },
  );

  test.each(NAMED_EXPORT_NAMES)(
    "%s throws the same Error when extra arguments the Node unpdf API would accept are supplied",
    (name: NamedExport) => {
      const fn = NAMED_EXPORTS[name];
      expectUnavailable(
        () =>
          Reflect.apply(fn, undefined, [
            new Uint8Array([0x25, 0x50, 0x44, 0x46]),
          ]),
        name,
      );
      expectUnavailable(
        () => Reflect.apply(fn, undefined, [new ArrayBuffer(0)]),
        name,
      );
      expectUnavailable(
        () =>
          Reflect.apply(fn, undefined, [
            "single-element",
            { overflow: true },
            undefined,
          ]),
        name,
      );
    },
  );

  test.each(NAMED_EXPORT_NAMES)(
    "%s keeps throwing on repeated calls (no unlock after the first miss)",
    (name: NamedExport) => {
      const fn = NAMED_EXPORTS[name];
      expectUnavailable(fn, name);
      expectUnavailable(fn, name);
    },
  );

  test.each(NAMED_EXPORT_NAMES)(
    "%s throws synchronously rather than returning a rejected Promise",
    (name: NamedExport) => {
      const fn = NAMED_EXPORTS[name];
      let thrown: unknown;
      try {
        const result = fn();
        throw new Error(
          `expected ${name} to throw synchronously, got ${String(result)}`,
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe(NOT_AVAILABLE);
      expect(thrown).not.toBeInstanceOf(Promise);
    },
  );

  test.each(NAMED_EXPORT_NAMES)(
    "%s on the default surface throws the same Error as the named export",
    (name: NamedExport) => {
      expectUnavailable(workerUnpdfSurface[name], name);
    },
  );

  test("empty extra-argument lists and a single dummy argument take the same throw path", () => {
    expectUnavailable(extractText, "extractText");
    expectUnavailable(
      () => Reflect.apply(extractText, undefined, []),
      "extractText",
    );
    expectUnavailable(
      () => Reflect.apply(extractText, undefined, ["one"]),
      "extractText",
    );
  });

  test("each call allocates a fresh Error instance (no shared thrown object)", () => {
    let first: unknown;
    let second: unknown;
    try {
      extractText();
    } catch (error) {
      first = error;
    }
    try {
      extractText();
    } catch (error) {
      second = error;
    }
    expect(first).toBeInstanceOf(Error);
    expect(second).toBeInstanceOf(Error);
    expect(first).not.toBe(second);
    expect((first as Error).message).toBe((second as Error).message);
  });

  test("concurrent calls each throw independently (no queue or overflow)", async () => {
    const outcomes = await Promise.all(
      NAMED_EXPORT_NAMES.map(async (name) => {
        try {
          NAMED_EXPORTS[name]();
          return { name, threw: false as const };
        } catch (error) {
          return {
            name,
            threw: true as const,
            message: (error as Error).message,
          };
        }
      }),
    );
    for (const outcome of outcomes) {
      expect(outcome.threw).toBe(true);
      if (outcome.threw) {
        expect(outcome.message).toBe(NOT_AVAILABLE);
      }
    }
  });
});
