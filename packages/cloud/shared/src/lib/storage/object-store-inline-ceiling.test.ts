/**
 * Covers the SQL inline-payload ceiling that keeps heavy payloads out of text
 * and jsonb columns when object storage is unconfigured. Deterministic: the
 * suite exercises the real helpers with storage env cleared, so every case
 * takes the inline branch without touching a network backend.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ObjectNamespaces } from "./object-namespace";
import {
  clampInlineDiagnosticText,
  InlinePayloadTooLargeError,
  inlinePayloadCeilingBytes,
  offloadJsonField,
  offloadTextField,
  shouldUseObjectStorage,
} from "./object-store";

const ENV_KEYS = [
  "STORAGE_PROVIDER",
  "STORAGE_ENDPOINT",
  "STORAGE_REGION",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_SECRET_ACCESS_KEY",
  "STORAGE_HEAVY_PAYLOADS_BUCKET",
  "STORAGE_BLOB_DEFAULT_BUCKET",
  "STORAGE_TRAJECTORIES_BUCKET",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_HEAVY_PAYLOADS_BUCKET",
  "R2_BLOB_DEFAULT_BUCKET",
  "R2_TRAJECTORIES_BUCKET",
  "SQL_HEAVY_PAYLOAD_STORAGE",
  "HEAVY_PAYLOAD_STORAGE",
  "SQL_HEAVY_PAYLOAD_MAX_INLINE_BYTES",
] as const;

const ORIGINAL = new Map(ENV_KEYS.map((key) => [key, process.env[key]] as const));

const baseParams = {
  namespace: ObjectNamespaces.JobPayloads,
  organizationId: "org-1",
  objectId: "job-1",
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.SQL_HEAVY_PAYLOAD_MAX_INLINE_BYTES = "2048";
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of ORIGINAL) {
    if (value !== undefined) process.env[key] = value;
  }
});

describe("inline payload ceiling", () => {
  test("object storage is genuinely unconfigured in this harness", () => {
    expect(shouldUseObjectStorage()).toBe(false);
    expect(inlinePayloadCeilingBytes()).toBe(2048);
  });

  test("a value under the ceiling is stored inline unchanged", async () => {
    const value = "x".repeat(100);
    const field = await offloadTextField({ ...baseParams, field: "error", value });
    expect(field).toEqual({ value, storage: "inline", key: null });
  });

  test("an oversize text field is refused by default rather than written inline", async () => {
    const value = "x".repeat(5000);
    const promise = offloadTextField({ ...baseParams, field: "error", value });
    await expect(promise).rejects.toBeInstanceOf(InlinePayloadTooLargeError);
    await promise.catch((error: unknown) => {
      // error-policy:J3 the rejection is the assertion subject, not a recovery path.
      const typed = error as InlinePayloadTooLargeError;
      expect(typed.code).toBe("INLINE_PAYLOAD_TOO_LARGE");
      expect(typed.field).toBe("error");
      expect(typed.sizeBytes).toBe(5000);
      expect(typed.maxInlineBytes).toBe(2048);
    });
  });

  test("a diagnostic field opted into clamping is bounded and marked", async () => {
    const value = "x".repeat(5000);
    const field = await offloadTextField({
      ...baseParams,
      field: "error",
      value,
      oversizeInline: "clamp",
    });
    expect(field.storage).toBe("inline");
    expect(field.key).toBeNull();
    const stored = field.value ?? "";
    expect(byteLength(stored)).toBeLessThanOrEqual(2048);
    expect(stored).toContain("truncated: 5000-byte payload");
  });

  test("oversize structured payloads are refused, never truncated", async () => {
    const value = { dump: "x".repeat(5000) };
    await expect(
      offloadJsonField<Record<string, unknown>>({
        ...baseParams,
        field: "data",
        value,
        inlineValueWhenOffloaded: null,
      }),
    ).rejects.toBeInstanceOf(InlinePayloadTooLargeError);
  });

  test("clamping preserves whole characters for multi-byte payloads", () => {
    process.env.SQL_HEAVY_PAYLOAD_MAX_INLINE_BYTES = "1024";
    const clamped = clampInlineDiagnosticText("é".repeat(4000));
    expect(byteLength(clamped)).toBeLessThanOrEqual(1024);
    expect(clamped.includes("�")).toBe(false);
  });

  test("clamping never allocates a payload-sized TextEncoder copy", () => {
    const originalTextEncoder = globalThis.TextEncoder;
    Object.defineProperty(globalThis, "TextEncoder", {
      configurable: true,
      value: class {
        encode(): never {
          throw new Error("TextEncoder.encode must not run at the ceiling boundary");
        }
      },
    });
    try {
      const clamped = clampInlineDiagnosticText("x".repeat(5000));
      expect(clamped).toContain("truncated: 5000-byte payload");
    } finally {
      Object.defineProperty(globalThis, "TextEncoder", {
        configurable: true,
        value: originalTextEncoder,
      });
    }
  });

  test("a ceiling below the 1024-byte floor falls back to the 1 MiB default", () => {
    process.env.SQL_HEAVY_PAYLOAD_MAX_INLINE_BYTES = "10";
    expect(inlinePayloadCeilingBytes()).toBe(1024 * 1024);
    process.env.SQL_HEAVY_PAYLOAD_MAX_INLINE_BYTES = "not-a-number";
    expect(inlinePayloadCeilingBytes()).toBe(1024 * 1024);
  });

  test("a null value is unaffected by the ceiling", async () => {
    const field = await offloadTextField({ ...baseParams, field: "error", value: null });
    expect(field).toEqual({ value: null, storage: "inline", key: null });
  });
});
