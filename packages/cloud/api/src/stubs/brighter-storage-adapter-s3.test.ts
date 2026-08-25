/**
 * Deterministic unit coverage for the workerd-safe @brighter/storage-adapter-s3
 * stub. Drives the real module with no mocks: Storage() constructs a
 * fail-closed adapter, and every method throws so accidental Worker-side S3
 * use cannot silently succeed. The stub has no queue, comparator, or capacity.
 */

import { describe, expect, test } from "vitest";
import { Storage } from "./brighter-storage-adapter-s3";

const UNAVAILABLE =
  "@brighter/storage-adapter-s3 is unavailable in the Cloudflare Worker bundle. Configure the native R2 binding or S3 route adapter before using this path.";

const METHOD_NAMES = [
  "write",
  "read",
  "stat",
  "exists",
  "remove",
  "list",
  "presign",
] as const;

type Adapter = ReturnType<typeof Storage>;
type AdapterMethod = (typeof METHOD_NAMES)[number];

function expectUnavailable(fn: () => never, method: AdapterMethod): void {
  expect(fn).toThrowError(UNAVAILABLE);
  try {
    fn();
    throw new Error(`expected Storage().${method}() to throw`);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe(UNAVAILABLE);
  }
}

describe("brighter-storage-adapter-s3 Worker stub", () => {
  test("exports Storage as a constructor function that does not throw", () => {
    expect(typeof Storage).toBe("function");
    expect(() => Storage()).not.toThrow();
  });

  test("returns an adapter whose own keys are the seven fail-closed methods in source order", () => {
    const adapter = Storage();
    expect(Object.keys(adapter)).toEqual([...METHOD_NAMES]);
    for (const name of METHOD_NAMES) {
      expect(Object.hasOwn(adapter, name)).toBe(true);
      expect(typeof adapter[name]).toBe("function");
    }
  });

  test("write throws the unavailable Error", () => {
    expectUnavailable(Storage().write, "write");
  });

  test("read throws the unavailable Error", () => {
    expectUnavailable(Storage().read, "read");
  });

  test("stat throws the unavailable Error", () => {
    expectUnavailable(Storage().stat, "stat");
  });

  test("exists throws the unavailable Error", () => {
    expectUnavailable(Storage().exists, "exists");
  });

  test("remove throws the unavailable Error even when the object is missing", () => {
    // There is no existence check: missing and present keys both throw before
    // any S3 lookup, because the Worker bundle never configures the adapter.
    expectUnavailable(Storage().remove, "remove");
  });

  test("list throws the unavailable Error on an empty listing path", () => {
    expectUnavailable(Storage().list, "list");
  });

  test("presign throws the unavailable Error", () => {
    expectUnavailable(Storage().presign, "presign");
  });

  test("constructs a new adapter object each call, sharing the module-level thrower", () => {
    const first = Storage();
    const second = Storage();
    expect(first).not.toBe(second);
    expect(first.write).toBe(first.read);
    expect(first.write).toBe(second.write);
    for (const name of METHOD_NAMES) {
      expect(first[name]).toBe(first.write);
      expect(second[name]).toBe(first.write);
    }
  });

  test("repeated calls on one adapter keep throwing (no capacity, overflow, or unlock)", () => {
    const adapter: Adapter = Storage();
    expectUnavailable(adapter.write, "write");
    expectUnavailable(adapter.write, "write");
    expectUnavailable(adapter.read, "read");
    expectUnavailable(adapter.list, "list");
  });

  test("does not expose queue, comparator, or capacity fields", () => {
    const adapter = Storage() as Adapter & Record<string, unknown>;
    expect("queue" in adapter).toBe(false);
    expect("capacity" in adapter).toBe(false);
    expect("comparator" in adapter).toBe(false);
    expect(adapter.queue).toBeUndefined();
  });
});
