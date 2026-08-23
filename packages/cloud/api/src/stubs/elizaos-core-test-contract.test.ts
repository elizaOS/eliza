/**
 * Deterministic unit coverage for the fail-loud @elizaos/core test-contract
 * stub. Drives the real module with no mocks: every function and constructor
 * throws before any core runtime work, object proxies throw on get and set,
 * and the document-list capability symbol is a unique local Symbol. The stub
 * has no queue, comparator, or capacity.
 */

import { describe, expect, test } from "vitest";
import * as contract from "./elizaos-core-test-contract";
import {
  ChannelType,
  canRequesterMutateDocument,
  DatabaseAdapter,
  DOCUMENT_LIST_QUERY_CAPABILITY_VERSION,
  decryptedCharacter,
  documentMutationSnapshotMatches,
  documentRoleHasGlobalVisibility,
  encryptedCharacter,
  logger,
  normalizePairingPageOptions,
  Service,
  validateDocumentFragmentQueryParams,
  validateDocumentListQueryParams,
  validateDocumentRequesterContext,
  validateQueryEntitiesPagination,
  validateUuid,
} from "./elizaos-core-test-contract";

const FUNCTIONS = {
  canRequesterMutateDocument,
  decryptedCharacter,
  documentMutationSnapshotMatches,
  documentRoleHasGlobalVisibility,
  encryptedCharacter,
  normalizePairingPageOptions,
  validateDocumentFragmentQueryParams,
  validateDocumentListQueryParams,
  validateDocumentRequesterContext,
  validateQueryEntitiesPagination,
  validateUuid,
} as const;

const CONSTRUCTORS = {
  DatabaseAdapter,
  Service,
} as const;

const OBJECTS = {
  ChannelType,
  logger,
} as const;

const FUNCTION_NAMES = Object.keys(FUNCTIONS) as Array<keyof typeof FUNCTIONS>;
const CONSTRUCTOR_NAMES = Object.keys(CONSTRUCTORS) as Array<
  keyof typeof CONSTRUCTORS
>;
const OBJECT_NAMES = Object.keys(OBJECTS) as Array<keyof typeof OBJECTS>;

const EXPORT_NAMES = [
  "canRequesterMutateDocument",
  "ChannelType",
  "DatabaseAdapter",
  "decryptedCharacter",
  "DOCUMENT_LIST_QUERY_CAPABILITY_VERSION",
  "documentMutationSnapshotMatches",
  "documentRoleHasGlobalVisibility",
  "encryptedCharacter",
  "logger",
  "normalizePairingPageOptions",
  "Service",
  "validateDocumentFragmentQueryParams",
  "validateDocumentListQueryParams",
  "validateDocumentRequesterContext",
  "validateQueryEntitiesPagination",
  "validateUuid",
] as const;

function unavailableMessage(name: string): string {
  return `@elizaos/core ${name} is outside this test path`;
}

function expectUnavailable(fn: () => unknown, name: string): void {
  const message = unavailableMessage(name);
  expect(fn).toThrowError(message);
  try {
    fn();
    throw new Error(`expected ${name} to throw`);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe(message);
  }
}

describe("elizaos-core-test-contract fail-loud stub", () => {
  test("exports exactly the sixteen stand-ins and nothing else", () => {
    // A module namespace object orders its own keys in code-unit order, not
    // source order, so compare as sorted sets rather than coupling the
    // assertion to how the export list happens to be written.
    expect([...Object.keys(contract)].sort()).toEqual([...EXPORT_NAMES].sort());
    expect(Object.keys(contract)).toHaveLength(16);
  });

  test("does not expose queue, comparator, or capacity fields", () => {
    const record = contract as unknown as Record<string, unknown>;
    expect("queue" in record).toBe(false);
    expect("capacity" in record).toBe(false);
    expect("comparator" in record).toBe(false);
    expect(record.queue).toBeUndefined();
    expect(record.capacity).toBeUndefined();
    expect(record.comparator).toBeUndefined();
  });

  test("function and constructor exports are distinct closures, not a shared thrower", () => {
    expect(validateUuid).not.toBe(encryptedCharacter);
    expect(canRequesterMutateDocument).not.toBe(
      documentMutationSnapshotMatches,
    );
    expect(DatabaseAdapter).not.toBe(Service);
    // Object.is: wrapping a throwing proxy in expect() trips the get trap.
    expect(Object.is(ChannelType, logger)).toBe(false);
  });

  describe("unavailable functions", () => {
    test.each(FUNCTION_NAMES)(
      "%s is a function that throws the unavailable Error with no arguments",
      (name) => {
        const fn = FUNCTIONS[name];
        expect(typeof fn).toBe("function");
        expectUnavailable(fn, name);
      },
    );

    test.each(FUNCTION_NAMES)(
      "%s throws the same Error when extra arguments are supplied (no comparator or overflow handling)",
      (name) => {
        const fn = FUNCTIONS[name];
        expectUnavailable(
          () => fn("single-element", { overflow: true }, undefined),
          name,
        );
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

  describe("unavailable constructors", () => {
    test.each(CONSTRUCTOR_NAMES)(
      "%s is a class whose constructor throws the unavailable Error",
      (name) => {
        const Ctor = CONSTRUCTORS[name] as new () => never;
        expect(typeof Ctor).toBe("function");
        expectUnavailable(() => new Ctor(), name);
      },
    );

    test.each(CONSTRUCTOR_NAMES)(
      "%s throws the same Error when constructed with extra arguments",
      (name) => {
        const Ctor = CONSTRUCTORS[name] as new (...args: unknown[]) => never;
        expectUnavailable(() => new Ctor("overflow"), name);
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
          expect((error as Error).message).not.toBe(unavailableMessage(name));
        }
      },
    );

    test.each(CONSTRUCTOR_NAMES)(
      "%s keeps throwing on repeated `new` (no capacity or unlock)",
      (name) => {
        const Ctor = CONSTRUCTORS[name] as new () => never;
        expectUnavailable(() => new Ctor(), name);
        expectUnavailable(() => new Ctor(), name);
      },
    );
  });

  describe("unavailable object proxies", () => {
    test.each(OBJECT_NAMES)(
      "%s is a null-prototype object whose own key list is empty",
      (name) => {
        const value = OBJECTS[name];
        expect(typeof value).toBe("object");
        expect(value === null).toBe(false);
        expect(Object.getPrototypeOf(value)).toBeNull();
        expect(Object.keys(value)).toEqual([]);
        expect(Object.getOwnPropertyNames(value)).toEqual([]);
      },
    );

    test.each(OBJECT_NAMES)(
      "%s throws the unavailable Error on get of a present-looking property",
      (name) => {
        expectUnavailable(() => Reflect.get(OBJECTS[name], "info"), name);
      },
    );

    test.each(OBJECT_NAMES)(
      "%s throws the unavailable Error on get of a missing property (no silent miss)",
      (name) => {
        expectUnavailable(
          () => Reflect.get(OBJECTS[name], "doesNotExist"),
          name,
        );
      },
    );

    test.each(OBJECT_NAMES)(
      "%s throws the unavailable Error on set of a missing property",
      (name) => {
        expectUnavailable(
          () => Reflect.set(OBJECTS[name], "doesNotExist", "value"),
          name,
        );
      },
    );

    test.each(OBJECT_NAMES)(
      "%s throws the unavailable Error on set even when the assigned value is empty",
      (name) => {
        expectUnavailable(
          () => Reflect.set(OBJECTS[name], "queue", undefined),
          name,
        );
      },
    );

    test.each(OBJECT_NAMES)(
      "%s `in` checks do not throw: the proxy has no `has` trap, so missing keys are false",
      (name) => {
        const value = OBJECTS[name];
        expect("info" in value).toBe(false);
        expect("queue" in value).toBe(false);
        expect("doesNotExist" in value).toBe(false);
      },
    );

    test.each(OBJECT_NAMES)(
      "%s keeps throwing on repeated get and set (no unlock)",
      (name) => {
        const value = OBJECTS[name];
        expectUnavailable(() => Reflect.get(value, "error"), name);
        expectUnavailable(() => Reflect.get(value, "error"), name);
        expectUnavailable(() => Reflect.set(value, "level", "info"), name);
        expectUnavailable(() => Reflect.set(value, "level", "info"), name);
      },
    );
  });

  describe("DOCUMENT_LIST_QUERY_CAPABILITY_VERSION", () => {
    test("is a unique local Symbol, not a globally interned one", () => {
      expect(typeof DOCUMENT_LIST_QUERY_CAPABILITY_VERSION).toBe("symbol");
      expect(DOCUMENT_LIST_QUERY_CAPABILITY_VERSION.description).toBe(
        "DOCUMENT_LIST_QUERY_CAPABILITY_VERSION outside this test path",
      );
      expect(DOCUMENT_LIST_QUERY_CAPABILITY_VERSION).not.toBe(
        Symbol.for(
          "DOCUMENT_LIST_QUERY_CAPABILITY_VERSION outside this test path",
        ),
      );
      expect(DOCUMENT_LIST_QUERY_CAPABILITY_VERSION).not.toBe(
        Symbol("DOCUMENT_LIST_QUERY_CAPABILITY_VERSION outside this test path"),
      );
    });

    test("is stable for the lifetime of the module (single interned export)", () => {
      expect(DOCUMENT_LIST_QUERY_CAPABILITY_VERSION).toBe(
        DOCUMENT_LIST_QUERY_CAPABILITY_VERSION,
      );
    });
  });

  test("empty extra-argument lists and a single dummy argument take the same throw path", () => {
    expectUnavailable(validateUuid, "validateUuid");
    expectUnavailable(() => validateUuid(), "validateUuid");
    expectUnavailable(() => validateUuid("one"), "validateUuid");
  });
});
