/**
 * Deterministic unit coverage for the workerd-safe ssh2 compatibility shim.
 * Drives the real module with no mocks: Client and Server constructors throw
 * before any native binding load, and the utils proxy throws on get so an
 * accidental Worker-side SSH call is visible immediately. The stub has no
 * queue, comparator, or capacity.
 */

import { describe, expect, test } from "vitest";
import { Client, Server, utils } from "./ssh2";

const NOT_AVAILABLE =
  "ssh2 is not available on Cloudflare Workers — proxy to the Node sidecar (cloud/INFRA.md).";

const CONSTRUCTORS = {
  Client,
  Server,
} as const;

const CONSTRUCTOR_NAMES = Object.keys(CONSTRUCTORS) as Array<
  keyof typeof CONSTRUCTORS
>;

function expectUnavailable(fn: () => unknown, label: string): void {
  expect(fn).toThrowError(NOT_AVAILABLE);
  try {
    fn();
    throw new Error(`expected ${label} to throw`);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe(NOT_AVAILABLE);
  }
}

describe("ssh2 Worker stub", () => {
  describe("unavailable constructors", () => {
    test.each(CONSTRUCTOR_NAMES)(
      "%s is a class whose constructor throws the unavailable Error",
      (name) => {
        const Ctor = CONSTRUCTORS[name] as new () => never;
        expect(typeof Ctor).toBe("function");
        expectUnavailable(() => new Ctor(), `new ${name}()`);
      },
    );

    test.each(CONSTRUCTOR_NAMES)(
      "%s throws the same Error when constructed with extra arguments (no overflow handling)",
      (name) => {
        const Ctor = CONSTRUCTORS[name] as new (...args: unknown[]) => never;
        expectUnavailable(
          () => new Ctor("single-element", { overflow: true }, undefined),
          `new ${name}(extra)`,
        );
      },
    );

    test.each(CONSTRUCTOR_NAMES)(
      "%s cannot be invoked without new (class constructor TypeError, not the unavailable Error)",
      (name) => {
        const Ctor = CONSTRUCTORS[name] as unknown as () => void;
        expect(Ctor).toThrow(TypeError);
        try {
          Ctor();
          throw new Error(`expected ${name}() without new to throw`);
        } catch (error) {
          expect(error).toBeInstanceOf(TypeError);
          expect((error as Error).message).not.toBe(NOT_AVAILABLE);
        }
      },
    );

    test.each(CONSTRUCTOR_NAMES)(
      "%s keeps throwing on repeated `new` (no capacity or unlock)",
      (name) => {
        const Ctor = CONSTRUCTORS[name] as new () => never;
        expectUnavailable(() => new Ctor(), `new ${name}() first`);
        expectUnavailable(() => new Ctor(), `new ${name}() second`);
      },
    );
  });

  describe("utils proxy", () => {
    test("is a null-own-key object whose prototype is Object.prototype", () => {
      expect(typeof utils).toBe("object");
      expect(utils === null).toBe(false);
      expect(Array.isArray(utils)).toBe(false);
      expect(Object.getPrototypeOf(utils)).toBe(Object.prototype);
      expect(Object.keys(utils)).toEqual([]);
      expect(Object.getOwnPropertyNames(utils)).toEqual([]);
      expect(Object.isFrozen(utils)).toBe(false);
      expect(Object.isSealed(utils)).toBe(false);
      expect(Object.isExtensible(utils)).toBe(true);
    });

    test("throws the unavailable Error on get of a present-looking ssh2 helper", () => {
      expectUnavailable(() => Reflect.get(utils, "parseKey"), "utils.parseKey");
    });

    test("throws the unavailable Error on get of a missing property (no silent miss)", () => {
      expectUnavailable(
        () => Reflect.get(utils, "doesNotExist"),
        "utils.doesNotExist",
      );
    });

    test("throws the unavailable Error on get of an empty string key (single empty element)", () => {
      expectUnavailable(() => Reflect.get(utils, ""), 'utils[""]');
    });

    test("`in` checks do not throw: the proxy has no `has` trap, so missing keys are false", () => {
      expect("parseKey" in utils).toBe(false);
      expect("queue" in utils).toBe(false);
      expect("doesNotExist" in utils).toBe(false);
      expect("" in utils).toBe(false);
    });

    test("deleting a missing key is a no-op and leaves the own-key list empty", () => {
      const record = utils as Record<string, unknown>;
      expect("doesNotExist" in record).toBe(false);
      const deleted = delete record.doesNotExist;
      expect(deleted).toBe(true);
      expect(Object.keys(utils)).toEqual([]);
      expect(Object.getOwnPropertyNames(utils)).toEqual([]);
    });

    test("set of a missing key succeeds (no set trap); get still throws; delete restores the empty own-key list", () => {
      const record = utils as Record<string, unknown>;
      expect("probeKey" in record).toBe(false);
      record.probeKey = "single-element";
      expect("probeKey" in record).toBe(true);
      expect(Object.keys(utils)).toEqual(["probeKey"]);
      expectUnavailable(
        () => Reflect.get(utils, "probeKey"),
        "utils.probeKey after set",
      );
      const deleted = delete record.probeKey;
      expect(deleted).toBe(true);
      expect("probeKey" in record).toBe(false);
      expect(Object.keys(utils)).toEqual([]);
    });

    test("keeps throwing on repeated get (no unlock after the first miss)", () => {
      expectUnavailable(
        () => Reflect.get(utils, "parseKey"),
        "utils.parseKey first",
      );
      expectUnavailable(
        () => Reflect.get(utils, "parseKey"),
        "utils.parseKey second",
      );
    });

    test("String and JSON.stringify throw because both look up properties through get", () => {
      expectUnavailable(() => String(utils), "String(utils)");
      expectUnavailable(() => JSON.stringify(utils), "JSON.stringify(utils)");
    });
  });
});
