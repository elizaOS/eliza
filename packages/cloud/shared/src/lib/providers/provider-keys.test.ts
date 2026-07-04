// Exercises provider keys behavior with deterministic cloud-shared lib fixtures.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getProviderKeys } from "./provider-env";

// Snapshot + restore the env keys this suite mutates so it can't leak.
const TOUCHED = [
  "CEREBRAS_API_KEY",
  "CEREBRAS_API_KEYS",
  "CEREBRAS_API_KEY_2",
  "CEREBRAS_API_KEY_3",
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of TOUCHED) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("getProviderKeys (multi-key provider rotation)", () => {
  test("returns empty when nothing configured", () => {
    expect(getProviderKeys("CEREBRAS_API_KEY")).toEqual([]);
  });

  test("returns the singular key when only it is set", () => {
    process.env.CEREBRAS_API_KEY = "k-single";
    expect(getProviderKeys("CEREBRAS_API_KEY")).toEqual(["k-single"]);
  });

  test("parses a comma/whitespace list from the plural env", () => {
    process.env.CEREBRAS_API_KEYS = "k1, k2  k3,k4";
    expect(getProviderKeys("CEREBRAS_API_KEY")).toEqual(["k1", "k2", "k3", "k4"]);
  });

  test("merges plural list + singular + numbered suffixes, de-duped, in order", () => {
    process.env.CEREBRAS_API_KEYS = "k1,k2";
    process.env.CEREBRAS_API_KEY = "k3";
    process.env.CEREBRAS_API_KEY_2 = "k4";
    process.env.CEREBRAS_API_KEY_3 = "k2"; // dup of list -> dropped
    expect(getProviderKeys("CEREBRAS_API_KEY")).toEqual(["k1", "k2", "k3", "k4"]);
  });

  test("filters placeholder + empty values", () => {
    process.env.CEREBRAS_API_KEYS = "your_cerebras_key, , real-key,  ";
    expect(getProviderKeys("CEREBRAS_API_KEY")).toEqual(["real-key"]);
  });

  test("de-dupes identical keys across sources", () => {
    process.env.CEREBRAS_API_KEY = "same";
    process.env.CEREBRAS_API_KEY_2 = "same";
    expect(getProviderKeys("CEREBRAS_API_KEY")).toEqual(["same"]);
  });
});
