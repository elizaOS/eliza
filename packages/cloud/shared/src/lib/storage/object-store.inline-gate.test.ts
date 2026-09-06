/**
 * The inline-payload ceiling and object-key derivation for heavy SQL payloads.
 *
 * The ceiling exists because unbounded inline writes put a quarter-gigabyte
 * failure dump in `jobs.error` (#22553), so its byte counter, its env parsing
 * and its boundary all matter. `byteLength` is hand-rolled specifically to
 * avoid materializing a second payload-sized buffer, and its comment claims it
 * matches `TextEncoder` "including unpaired surrogates" — that claim is
 * asserted here against `TextEncoder` itself rather than trusted.
 *
 * Mock-free: every case drives the real exports through `process.env`, which
 * `getCloudAwareEnv()` falls through to outside a request.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  assertInlinePayloadFits,
  buildObjectFieldKey,
  InlinePayloadTooLargeError,
  inlinePayloadCeilingBytes,
  shouldUseObjectStorage,
} from "./object-store";

const DEFAULT_CEILING = 1024 * 1024;
const HIGH_SURROGATE = String.fromCharCode(0xd83d);
const LOW_SURROGATE = String.fromCharCode(0xdc00);

const STORAGE_ENV = [
  "SQL_HEAVY_PAYLOAD_MAX_INLINE_BYTES",
  "SQL_HEAVY_PAYLOAD_STORAGE",
  "HEAVY_PAYLOAD_STORAGE",
  "STORAGE_PROVIDER",
  "STORAGE_ENDPOINT",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_SECRET_ACCESS_KEY",
  "STORAGE_HEAVY_PAYLOADS_BUCKET",
] as const;

/** Minimal S3-compatible configuration that makes `storageConfigured()` true. */
function configureObjectStorage(): void {
  process.env.STORAGE_PROVIDER = "s3";
  process.env.STORAGE_ENDPOINT = "https://storage.example.invalid";
  process.env.STORAGE_ACCESS_KEY_ID = "access-key";
  process.env.STORAGE_SECRET_ACCESS_KEY = "secret-key";
  process.env.STORAGE_HEAVY_PAYLOADS_BUCKET = "heavy-payloads";
}

afterEach(() => {
  for (const key of STORAGE_ENV) delete process.env[key];
});

/** Recovers the counter's own answer for `value` through the thrown error. */
function measuredBytes(value: string): number {
  process.env.SQL_HEAVY_PAYLOAD_MAX_INLINE_BYTES = "1024";
  try {
    assertInlinePayloadFits("field", `${value}${"a".repeat(1025)}`);
  } catch (error) {
    if (error instanceof InlinePayloadTooLargeError) return error.sizeBytes - 1025;
    throw error;
  }
  throw new Error("expected the padded value to exceed the ceiling");
}

describe("the inline byte counter matches TextEncoder", () => {
  const cases: Array<[string, string]> = [
    ["ascii", "plain-ascii-payload"],
    ["two-byte (Latin-1 supplement)", "café-ünïcödé"],
    ["two-byte (Cyrillic)", "привет"],
    ["three-byte (CJK)", "日本語テキスト"],
    ["four-byte (astral, surrogate pair)", "🚀🛰🌍"],
    ["mixed widths", "a√日🚀"],
    ["empty", ""],
  ];

  for (const [label, value] of cases) {
    test(`agrees on ${label}`, () => {
      expect(measuredBytes(value)).toBe(new TextEncoder().encode(value).length);
    });
  }

  test("agrees on a lone high surrogate", () => {
    // The comment claims parity with TextEncoder's U+FFFD replacement, which is
    // three bytes. A counter that assumed every high surrogate starts a pair
    // would report four and silently under-count the real payload.
    expect(measuredBytes(HIGH_SURROGATE)).toBe(new TextEncoder().encode(HIGH_SURROGATE).length);
    expect(measuredBytes(HIGH_SURROGATE)).toBe(3);
  });

  test("agrees on a lone low surrogate and on a reversed pair", () => {
    for (const value of [LOW_SURROGATE, `${LOW_SURROGATE}${HIGH_SURROGATE}`]) {
      expect(measuredBytes(value)).toBe(new TextEncoder().encode(value).length);
    }
  });

  test("two adjacent surrogates of the SAME half are not a pair", () => {
    // Only high-then-low is a pair. Both of these are two independent
    // replacement characters (3 + 3), and each pins one half of the pairing
    // range: widening the start test to accept a low surrogate, or the
    // continuation test to accept a high one, turns 6 bytes into 4.
    for (const value of [
      `${HIGH_SURROGATE}${HIGH_SURROGATE}`,
      `${LOW_SURROGATE}${LOW_SURROGATE}`,
    ]) {
      expect(measuredBytes(value)).toBe(new TextEncoder().encode(value).length);
      expect(measuredBytes(value)).toBe(6);
    }
  });

  test("agrees on a high surrogate at the very end of the string", () => {
    // The pairing branch reads index + 1, so a trailing high surrogate is the
    // off-by-one case.
    const trailing = `ok${HIGH_SURROGATE}`;
    expect(measuredBytes(trailing)).toBe(new TextEncoder().encode(trailing).length);
  });
});

describe("inlinePayloadCeilingBytes env parsing", () => {
  test("defaults to 1 MiB when unset", () => {
    expect(inlinePayloadCeilingBytes()).toBe(DEFAULT_CEILING);
  });

  test("falls back to the default rather than trusting an implausible floor", () => {
    // Below 1024 an operator has almost certainly mis-set the variable; taking
    // it literally would refuse every payload.
    for (const raw of ["0", "1023", "-5000", "not-a-number", "NaN", "Infinity"]) {
      process.env.SQL_HEAVY_PAYLOAD_MAX_INLINE_BYTES = raw;
      expect(inlinePayloadCeilingBytes()).toBe(DEFAULT_CEILING);
    }
  });

  test("accepts 1024 as the lowest honoured value and floors a fraction", () => {
    process.env.SQL_HEAVY_PAYLOAD_MAX_INLINE_BYTES = "1024";
    expect(inlinePayloadCeilingBytes()).toBe(1024);
    process.env.SQL_HEAVY_PAYLOAD_MAX_INLINE_BYTES = "2048.9";
    expect(inlinePayloadCeilingBytes()).toBe(2048);
  });
});

describe("assertInlinePayloadFits", () => {
  test("permits a payload exactly at the ceiling and refuses one byte more", () => {
    process.env.SQL_HEAVY_PAYLOAD_MAX_INLINE_BYTES = "1024";
    expect(() => assertInlinePayloadFits("error", "a".repeat(1024))).not.toThrow();
    expect(() => assertInlinePayloadFits("error", "a".repeat(1025))).toThrow(
      InlinePayloadTooLargeError,
    );
  });

  test("measures bytes, not characters", () => {
    process.env.SQL_HEAVY_PAYLOAD_MAX_INLINE_BYTES = "1024";
    // 400 astral characters are 1,600 UTF-8 bytes but only 800 UTF-16 units,
    // so a length-based check would let this through.
    expect(() => assertInlinePayloadFits("error", "🚀".repeat(400))).toThrow(
      InlinePayloadTooLargeError,
    );
  });

  test("carries the field, the measured size and the ceiling for the caller", () => {
    process.env.SQL_HEAVY_PAYLOAD_MAX_INLINE_BYTES = "1024";
    try {
      assertInlinePayloadFits("jobs.error", "a".repeat(2000));
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(InlinePayloadTooLargeError);
      const typed = error as InlinePayloadTooLargeError;
      expect(typed.code).toBe("INLINE_PAYLOAD_TOO_LARGE");
      expect(typed.field).toBe("jobs.error");
      expect(typed.sizeBytes).toBe(2000);
      expect(typed.maxInlineBytes).toBe(1024);
      expect(typed.message).toContain("jobs.error");
      expect(typed.message).toContain("SQL_HEAVY_PAYLOAD_STORAGE");
    }
  });
});

describe("buildObjectFieldKey", () => {
  const base = {
    namespace: "jobs" as never,
    organizationId: "11111111-2222-4333-8444-555555555555",
    objectId: "job-abc",
    field: "error",
    createdAt: new Date("2026-03-04T05:06:07.000Z"),
    extension: "json" as const,
  };

  test("lays out namespace / org / UTC day / object / field.ext", () => {
    expect(buildObjectFieldKey(base)).toBe(
      "jobs/11111111-2222-4333-8444-555555555555/2026-03-04/job-abc/error.json",
    );
  });

  test("the day segment is UTC, not local", () => {
    // A local-date key would move the object between days for half the world.
    expect(
      buildObjectFieldKey({ ...base, createdAt: new Date("2026-03-04T23:59:59.999Z") }),
    ).toContain("/2026-03-04/");
    expect(
      buildObjectFieldKey({ ...base, createdAt: new Date("2026-03-05T00:00:00.000Z") }),
    ).toContain("/2026-03-05/");
  });

  test("a version becomes its own filename segment before the extension", () => {
    expect(buildObjectFieldKey({ ...base, version: "g7" })).toBe(
      "jobs/11111111-2222-4333-8444-555555555555/2026-03-04/job-abc/error.g7.json",
    );
  });

  test("no caller-supplied segment can introduce a path separator", () => {
    // This is what keeps a hostile objectId or field from escaping its prefix.
    const key = buildObjectFieldKey({
      ...base,
      organizationId: "../../other-org",
      objectId: "../../../etc/passwd",
      field: "a/b\\c",
      version: "v/1",
    });
    const segments = key.split("/");
    expect(segments).toHaveLength(5);
    expect(segments[0]).toBe("jobs");
    expect(segments[1]).toBe(".._.._other-org");
    expect(segments[2]).toBe("2026-03-04");
    expect(segments[3]).toBe(".._.._.._etc_passwd");
    expect(segments[4]).toBe("a_b_c.v_1.json");
  });

  test("collapses every character outside the key alphabet", () => {
    const hostile = `sp ce${String.fromCharCode(9)}tab é🚀?#%`;
    const objectSegment = buildObjectFieldKey({ ...base, objectId: hostile }).split("/")[3];
    expect(objectSegment).toMatch(/^[a-zA-Z0-9._=-]+$/);
    expect(objectSegment).not.toContain(" ");
  });

  test("keeps the alphabet's own characters intact", () => {
    expect(buildObjectFieldKey({ ...base, objectId: "Ab9._=-" }).split("/")[3]).toBe("Ab9._=-");
  });
});

describe("shouldUseObjectStorage", () => {
  test("is true when storage is configured and no mode overrides it", () => {
    configureObjectStorage();
    expect(shouldUseObjectStorage()).toBe(true);
  });

  test("inline overrides fully configured storage", () => {
    // Asserted against configured storage on purpose: with nothing configured
    // the fallthrough returns false anyway, so an inline branch that stopped
    // matching would be invisible.
    configureObjectStorage();
    process.env.SQL_HEAVY_PAYLOAD_STORAGE = "inline";
    expect(shouldUseObjectStorage()).toBe(false);
  });

  test("is false when the mode is inline and nothing is configured", () => {
    process.env.SQL_HEAVY_PAYLOAD_STORAGE = "inline";
    expect(shouldUseObjectStorage()).toBe(false);
  });

  test("an explicit r2 mode with storage configured is true", () => {
    configureObjectStorage();
    process.env.SQL_HEAVY_PAYLOAD_STORAGE = "r2";
    expect(shouldUseObjectStorage()).toBe(true);
  });

  test("SQL_HEAVY_PAYLOAD_STORAGE wins over the legacy HEAVY_PAYLOAD_STORAGE", () => {
    configureObjectStorage();
    process.env.SQL_HEAVY_PAYLOAD_STORAGE = "inline";
    process.env.HEAVY_PAYLOAD_STORAGE = "r2";
    expect(shouldUseObjectStorage()).toBe(false);
  });

  test("the legacy variable still applies on its own", () => {
    configureObjectStorage();
    process.env.HEAVY_PAYLOAD_STORAGE = "inline";
    expect(shouldUseObjectStorage()).toBe(false);
  });

  test("demanding r2 without a configured bucket fails loudly, not silently inline", () => {
    process.env.SQL_HEAVY_PAYLOAD_STORAGE = "r2";
    expect(() => shouldUseObjectStorage()).toThrow(/no Worker R2 binding|S3-compatible/i);
  });

  test("with no mode set and nothing configured it stays inline", () => {
    expect(shouldUseObjectStorage()).toBe(false);
  });
});
