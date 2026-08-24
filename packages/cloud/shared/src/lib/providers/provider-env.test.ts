/**
 * Covers the shared provider-credential gate.
 *
 * The placeholder rule is the point of the module: a scaffolded `.env` ships
 * values like `your_openai_key` or `REPLACE_WITH_KEY`, and treating one as a
 * real credential means the provider is reported as configured and the failure
 * surfaces later as an opaque 401 from the vendor instead of as "not
 * configured" here.
 *
 * `getProviderKeys` additionally has to merge three sources without emitting a
 * duplicate, because callers rotate across the list to spread rate-limit
 * headroom and a repeated key would silently weight one credential.
 *
 * Env is set per test and restored afterwards.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  getProviderKey,
  getProviderKeys,
  getRequiredProviderKey,
  isPlaceholderProviderKey,
} from "./provider-env";

const BASE = "TEST_PROVIDER_API_KEY";
const touched = new Set<string>();

function setEnv(name: string, value: string | undefined): void {
  touched.add(name);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith(BASE)) delete process.env[name];
  }
});

afterEach(() => {
  for (const name of touched) delete process.env[name];
  touched.clear();
});

describe("isPlaceholderProviderKey", () => {
  test("treats absent and blank values as unconfigured", () => {
    expect(isPlaceholderProviderKey(undefined)).toBe(true);
    expect(isPlaceholderProviderKey("")).toBe(true);
    expect(isPlaceholderProviderKey("   ")).toBe(true);
  });

  test("rejects the scaffolded template values", () => {
    for (const value of [
      "placeholder",
      "PLACEHOLDER",
      "replace_with_key",
      "REPLACE_WITH_KEY",
      "your_openai_key",
      "your_groq_api_key",
      "your-api-key",
      "sk-your_key_here",
    ]) {
      expect(isPlaceholderProviderKey(value)).toBe(true);
    }
  });

  test("accepts a realistic credential", () => {
    for (const value of ["sk-proj-abc123", "csk-1234567890", "  sk-with-space  ", "gsk_liveKey"]) {
      expect(isPlaceholderProviderKey(value)).toBe(false);
    }
  });
});

describe("getProviderKey", () => {
  test("returns null when the variable is unset", () => {
    expect(getProviderKey(BASE)).toBeNull();
  });

  test("returns null for a placeholder value", () => {
    setEnv(BASE, "your_openai_key");
    expect(getProviderKey(BASE)).toBeNull();
  });

  test("returns null for a whitespace-only value", () => {
    setEnv(BASE, "   ");
    expect(getProviderKey(BASE)).toBeNull();
  });

  test("returns the trimmed key when configured", () => {
    setEnv(BASE, "  sk-real-key  ");
    expect(getProviderKey(BASE)).toBe("sk-real-key");
  });
});

describe("getRequiredProviderKey", () => {
  test("returns the key when configured", () => {
    setEnv(BASE, "sk-real-key");
    expect(getRequiredProviderKey(BASE)).toBe("sk-real-key");
  });

  test("throws naming the variable when unset or placeholder", () => {
    expect(() => getRequiredProviderKey(BASE)).toThrow(BASE);
    setEnv(BASE, "placeholder");
    expect(() => getRequiredProviderKey(BASE)).toThrow(BASE);
  });
});

describe("getProviderKeys", () => {
  test("returns an empty list when nothing is configured", () => {
    expect(getProviderKeys(BASE)).toEqual([]);
  });

  test("reads the singular variable", () => {
    setEnv(BASE, "k1");
    expect(getProviderKeys(BASE)).toEqual(["k1"]);
  });

  test("splits the plural list on commas and whitespace", () => {
    setEnv(`${BASE}S`, "k1,k2 k3,  k4");
    expect(getProviderKeys(BASE)).toEqual(["k1", "k2", "k3", "k4"]);
  });

  test("reads numbered suffixes after the singular", () => {
    setEnv(BASE, "k1");
    setEnv(`${BASE}_2`, "k2");
    setEnv(`${BASE}_3`, "k3");
    expect(getProviderKeys(BASE)).toEqual(["k1", "k2", "k3"]);
  });

  test("merges all three sources in the documented order", () => {
    setEnv(`${BASE}S`, "plural1,plural2");
    setEnv(BASE, "singular");
    setEnv(`${BASE}_2`, "numbered");
    expect(getProviderKeys(BASE)).toEqual(["plural1", "plural2", "singular", "numbered"]);
  });

  test("never emits a duplicate, so rotation cannot over-weight one credential", () => {
    setEnv(`${BASE}S`, "dup,dup");
    setEnv(BASE, "dup");
    setEnv(`${BASE}_2`, "dup");
    expect(getProviderKeys(BASE)).toEqual(["dup"]);
  });

  test("filters placeholders out of every source", () => {
    setEnv(`${BASE}S`, "placeholder,real1");
    setEnv(BASE, "your_openai_key");
    setEnv(`${BASE}_2`, "real2");
    expect(getProviderKeys(BASE)).toEqual(["real1", "real2"]);
  });

  test("stops scanning numbered suffixes at the documented cap", () => {
    setEnv(`${BASE}_16`, "in-range");
    setEnv(`${BASE}_17`, "out-of-range");
    const keys = getProviderKeys(BASE);
    expect(keys).toContain("in-range");
    expect(keys).not.toContain("out-of-range");
  });

  test("does not stop at a gap in the numbered sequence", () => {
    setEnv(`${BASE}_2`, "k2");
    setEnv(`${BASE}_5`, "k5");
    expect(getProviderKeys(BASE)).toEqual(["k2", "k5"]);
  });
});
