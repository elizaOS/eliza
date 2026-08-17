/**
 * Adversarial contract tests for catalog-fenced native R2 HEAD and streamed GET reads.
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  RuntimeR2Bucket,
  RuntimeR2ConditionalGetOptions,
  RuntimeR2GetOptions,
  RuntimeR2Object,
  RuntimeR2ObjectMetadata,
  RuntimeR2PutOptions,
} from "../../storage/r2-runtime-binding";
import {
  buildNativeStoragePrivateHeaders,
  evaluateNativeStorageClientConditionals,
  isCanonicalNativeStorageRelativeKey,
  type NativeStorageReadSnapshot,
  type NativeStorageResolvedRange,
  openNativeStorageGet,
  parseNativeStorageRange,
  resolveNativeStorageRange,
  verifyNativeStorageHead,
} from "./native-storage-read";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const OBJECT_ID = "22222222-2222-4222-8222-222222222222";
const OBJECT_KEY = `org/${ORGANIZATION_ID}/reports/summary.txt`;
const PROVIDER_KEY = `__eliza_storage_authority/v1/org/${ORGANIZATION_ID}/${OBJECT_ID}/7`;
const PROVIDER_ETAG = "0123456789abcdef";
const PROVIDER_VERSION = "provider-version-7";
const UPLOADED_AT = new Date("2026-08-17T12:34:56.000Z");
const CHECKSUM_HEX = Array.from({ length: 32 }, (_, index) =>
  index.toString(16).padStart(2, "0"),
).join("");

const SNAPSHOT: NativeStorageReadSnapshot = Object.freeze({
  organizationId: ORGANIZATION_ID,
  objectId: OBJECT_ID,
  objectKey: OBJECT_KEY,
  committedGeneration: 7n,
  sizeBytes: 10n,
  providerKey: PROVIDER_KEY,
  providerVersion: PROVIDER_VERSION,
  providerEtag: PROVIDER_ETAG,
  contentType: "text/plain; charset=utf-8",
  checksumSha256: CHECKSUM_HEX,
  providerUploadedAt: UPLOADED_AT,
});

function checksumBytes(): ArrayBuffer {
  return Uint8Array.from({ length: 32 }, (_, index) => index).buffer;
}

function metadata(overrides: Partial<RuntimeR2ObjectMetadata> = {}): RuntimeR2ObjectMetadata {
  return {
    key: PROVIDER_KEY,
    version: PROVIDER_VERSION,
    size: 10,
    etag: PROVIDER_ETAG,
    httpEtag: `"${PROVIDER_ETAG}"`,
    uploaded: new Date(UPLOADED_AT),
    httpMetadata: { contentType: SNAPSHOT.contentType },
    checksums: { sha256: checksumBytes() },
    ...overrides,
  };
}

class TrackingReadableStream extends ReadableStream<Uint8Array> {
  cancelAttempts = 0;

  override cancel(reason?: unknown): Promise<void> {
    this.cancelAttempts += 1;
    return super.cancel(reason);
  }
}

function responseObject(
  body: ReadableStream<Uint8Array> = new TrackingReadableStream(),
  overrides: Partial<RuntimeR2Object> = {},
): RuntimeR2Object {
  return {
    ...metadata(),
    body,
    bodyUsed: false,
    text: mock(async () => {
      throw new Error("text() must not be called");
    }),
    arrayBuffer: mock(async () => {
      throw new Error("arrayBuffer() must not be called");
    }),
    ...overrides,
  };
}

class FakeRuntimeR2Bucket implements RuntimeR2Bucket {
  headResult: RuntimeR2ObjectMetadata | null = metadata();
  getResult: RuntimeR2Object | RuntimeR2ObjectMetadata | null = responseObject();
  headError: Error | null = null;
  getError: Error | null = null;
  readonly headCalls: string[] = [];
  readonly getCalls: Array<{ key: string; options: RuntimeR2GetOptions | undefined }> = [];

  async head(key: string): Promise<RuntimeR2ObjectMetadata | null> {
    this.headCalls.push(key);
    if (this.headError) throw this.headError;
    return this.headResult;
  }

  get(
    key: string,
    options: RuntimeR2ConditionalGetOptions,
  ): Promise<RuntimeR2Object | RuntimeR2ObjectMetadata | null>;
  get(key: string, options?: RuntimeR2GetOptions): Promise<RuntimeR2Object | null>;
  async get(
    key: string,
    options?: RuntimeR2GetOptions,
  ): Promise<RuntimeR2Object | RuntimeR2ObjectMetadata | null> {
    this.getCalls.push({ key, options });
    if (this.getError) throw this.getError;
    return this.getResult;
  }

  async put(
    _key: string,
    _value: string | ArrayBuffer | ArrayBufferView | Blob | null,
    _options?: RuntimeR2PutOptions,
  ): Promise<unknown> {
    return {};
  }

  async delete(_key: string): Promise<unknown> {
    return {};
  }
}

function parsedRange(value: string) {
  const parsed = parseNativeStorageRange(value);
  if (parsed.outcome !== "parsed") throw new Error("Expected a parsed range");
  return parsed.range;
}

function resolvedRange(value: string, sizeBytes = SNAPSHOT.sizeBytes): NativeStorageResolvedRange {
  const resolved = resolveNativeStorageRange(parsedRange(value), sizeBytes);
  if (resolved.outcome !== "satisfiable") throw new Error("Expected a satisfiable range");
  return resolved.range;
}

async function expectReadError(
  promise: Promise<unknown>,
  code: string,
  forbidden: readonly string[] = [],
): Promise<Error> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    // error-policy:J3 the helper captures the expected typed rejection for assertions below.
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(caught).toMatchObject({ name: "NativeStorageReadError", code });
  if (!(caught instanceof Error)) throw new Error("Expected a native storage read error");
  const message = caught instanceof Error ? caught.message : String(caught);
  for (const value of forbidden) expect(message).not.toContain(value);
  return caught;
}

describe("native storage key and Range parsing", () => {
  test("accepts canonical NFC relative keys and rejects unsafe variants", () => {
    expect(isCanonicalNativeStorageRelativeKey("org/id/caf\u00e9/file.txt")).toBe(true);
    expect(isCanonicalNativeStorageRelativeKey("/absolute")).toBe(false);
    expect(isCanonicalNativeStorageRelativeKey("org/id/../secret")).toBe(false);
    expect(isCanonicalNativeStorageRelativeKey("org/id/./file")).toBe(false);
    expect(isCanonicalNativeStorageRelativeKey("org/id//file")).toBe(false);
    expect(isCanonicalNativeStorageRelativeKey("org/id/")).toBe(false);
    expect(isCanonicalNativeStorageRelativeKey("org/id/control\u0000key")).toBe(false);
    expect(isCanonicalNativeStorageRelativeKey("org/id/cafe\u0301/file.txt")).toBe(false);
    expect(isCanonicalNativeStorageRelativeKey("x".repeat(1_025))).toBe(false);
  });

  test("parses and resolves bounded, open, and suffix ranges", () => {
    expect(parseNativeStorageRange(null)).toEqual({ outcome: "absent" });
    expect(parseNativeStorageRange("bytes=2-5")).toEqual({
      outcome: "parsed",
      range: { kind: "bounded", start: 2, end: 5 },
    });
    expect(resolveNativeStorageRange(parsedRange("bytes=2-50"), 10n)).toEqual({
      outcome: "satisfiable",
      range: { offset: 2, end: 9, length: 8, contentRange: "bytes 2-9/10" },
    });
    expect(resolveNativeStorageRange(parsedRange("bytes=4-"), 10n)).toEqual({
      outcome: "satisfiable",
      range: { offset: 4, end: 9, length: 6, contentRange: "bytes 4-9/10" },
    });
    expect(resolveNativeStorageRange(parsedRange("bytes=-4"), 10n)).toEqual({
      outcome: "satisfiable",
      range: { offset: 6, end: 9, length: 4, contentRange: "bytes 6-9/10" },
    });
    expect(resolveNativeStorageRange(parsedRange("bytes=-50"), 10n)).toEqual({
      outcome: "satisfiable",
      range: { offset: 0, end: 9, length: 10, contentRange: "bytes 0-9/10" },
    });
  });

  test("rejects malformed, multiple, reversed, zero, and overflowing ranges", () => {
    expect(parseNativeStorageRange("items=0-1")).toEqual({
      outcome: "invalid",
      reason: "malformed",
    });
    expect(parseNativeStorageRange("bytes=0-1,4-5")).toEqual({
      outcome: "invalid",
      reason: "multiple_ranges",
    });
    expect(parseNativeStorageRange("bytes=5-4")).toEqual({
      outcome: "invalid",
      reason: "reversed",
    });
    expect(parseNativeStorageRange("bytes=-0")).toEqual({
      outcome: "invalid",
      reason: "zero_suffix",
    });
    expect(parseNativeStorageRange("bytes=9007199254740992-")).toEqual({
      outcome: "invalid",
      reason: "overflow",
    });
    expect(parseNativeStorageRange(`bytes=${"9".repeat(129)}-`)).toEqual({
      outcome: "invalid",
      reason: "overflow",
    });
    expect(resolveNativeStorageRange(parsedRange("bytes=10-"), 10n)).toEqual({
      outcome: "unsatisfiable",
    });
    expect(resolveNativeStorageRange(parsedRange("bytes=0-"), 0n)).toEqual({
      outcome: "unsatisfiable",
    });
    for (const range of [
      { kind: "open", start: -1 },
      { kind: "open", start: Number.NaN },
      { kind: "open", start: Number.POSITIVE_INFINITY },
      { kind: "open", start: 1.5 },
      { kind: "suffix", length: 0 },
      { kind: "bounded", start: 4, end: 3 },
    ] as const) {
      expect(() => resolveNativeStorageRange(range, 10n)).toThrow(
        expect.objectContaining({ code: "NATIVE_STORAGE_INVALID_RANGE" }),
      );
    }
    expect(Reflect.apply(parseNativeStorageRange, undefined, [42])).toEqual({
      outcome: "invalid",
      reason: "malformed",
    });
    expect(() =>
      Reflect.apply(resolveNativeStorageRange, undefined, [{ kind: "open", start: 0 }, 10]),
    ).toThrow(expect.objectContaining({ code: "NATIVE_STORAGE_INVALID_RANGE" }));
  });
});

describe("native storage client conditionals", () => {
  test("uses strong If-Match precedence over If-Unmodified-Since", () => {
    expect(
      evaluateNativeStorageClientConditionals(
        new Headers({
          "If-Match": `"${PROVIDER_ETAG}"`,
          "If-Unmodified-Since": "Mon, 17 Aug 2020 12:34:56 GMT",
        }),
        SNAPSHOT,
        false,
      ),
    ).toEqual({ outcome: "proceed", useRange: false });
    expect(
      evaluateNativeStorageClientConditionals(
        new Headers({ "If-Match": `W/"${PROVIDER_ETAG}"` }),
        SNAPSHOT,
        false,
      ),
    ).toEqual({ outcome: "precondition_failed", useRange: false });
    expect(
      evaluateNativeStorageClientConditionals(
        new Headers({ "If-Unmodified-Since": "Mon, 17 Aug 2020 12:34:56 GMT" }),
        SNAPSHOT,
        false,
      ),
    ).toEqual({ outcome: "precondition_failed", useRange: false });
  });

  test("uses weak If-None-Match comparison and suppresses If-Modified-Since", () => {
    expect(
      evaluateNativeStorageClientConditionals(
        new Headers({ "If-None-Match": `W/"${PROVIDER_ETAG}"` }),
        SNAPSHOT,
        false,
      ),
    ).toEqual({ outcome: "not_modified", useRange: false });
    expect(
      evaluateNativeStorageClientConditionals(
        new Headers({
          "If-None-Match": '"different"',
          "If-Modified-Since": "Mon, 17 Aug 2099 12:34:56 GMT",
        }),
        SNAPSHOT,
        false,
      ),
    ).toEqual({ outcome: "proceed", useRange: false });
    expect(
      evaluateNativeStorageClientConditionals(
        new Headers({ "If-Modified-Since": UPLOADED_AT.toUTCString() }),
        SNAPSHOT,
        false,
      ),
    ).toEqual({ outcome: "not_modified", useRange: false });
  });

  test("ignores bounded empty list members for list-based entity-tag conditions", () => {
    expect(
      evaluateNativeStorageClientConditionals(
        new Headers({ "If-Match": `, , "${PROVIDER_ETAG}",` }),
        SNAPSHOT,
        false,
      ),
    ).toEqual({ outcome: "proceed", useRange: false });
    expect(
      evaluateNativeStorageClientConditionals(
        new Headers({ "If-None-Match": `, W/"${PROVIDER_ETAG}", ,` }),
        SNAPSHOT,
        false,
      ),
    ).toEqual({ outcome: "not_modified", useRange: false });
    expect(
      evaluateNativeStorageClientConditionals(
        new Headers({ "If-Match": `${", ".repeat(129)}"${PROVIDER_ETAG}"` }),
        SNAPSHOT,
        false,
      ),
    ).toEqual({ outcome: "precondition_failed", useRange: false });
  });

  test("strictly parses RFC HTTP dates instead of Date.parse extensions", () => {
    for (const value of [
      "Mon, 17 Aug 2026 12:34:56 GMT",
      "Monday, 17-Aug-26 12:34:56 GMT",
      "Mon Aug 17 12:34:56 2026",
    ]) {
      expect(
        evaluateNativeStorageClientConditionals(
          new Headers({ "If-Modified-Since": value }),
          SNAPSHOT,
          false,
        ),
      ).toEqual({ outcome: "not_modified", useRange: false });
    }
    expect(
      evaluateNativeStorageClientConditionals(
        new Headers({ "If-Modified-Since": "2026-08-17T12:34:56.000Z" }),
        SNAPSHOT,
        false,
      ),
    ).toEqual({ outcome: "proceed", useRange: false });
    expect(
      evaluateNativeStorageClientConditionals(
        new Headers({ "If-Modified-Since": "Sun, 17 Aug 2026 12:34:56 GMT" }),
        SNAPSHOT,
        false,
      ),
    ).toEqual({ outcome: "proceed", useRange: false });
    expect(
      evaluateNativeStorageClientConditionals(
        new Headers({ "If-Unmodified-Since": "Sun, 17 Aug 1800 12:34:56 GMT" }),
        SNAPSHOT,
        false,
      ),
    ).toEqual({ outcome: "proceed", useRange: false });
    expect(
      evaluateNativeStorageClientConditionals(
        new Headers({ "If-Unmodified-Since": "Mon, 17 Aug 2020 12:34:60 GMT" }),
        SNAPSHOT,
        false,
      ),
    ).toEqual({ outcome: "precondition_failed", useRange: false });
  });

  test("honors only strong matching If-Range validators", () => {
    const cases: Array<[Headers, boolean]> = [
      [new Headers(), true],
      [new Headers({ "If-Range": `"${PROVIDER_ETAG}"` }), true],
      [new Headers({ "If-Range": `W/"${PROVIDER_ETAG}"` }), false],
      [new Headers({ "If-Range": '"different"' }), false],
      [new Headers({ "If-Range": UPLOADED_AT.toUTCString() }), false],
      [new Headers({ "If-Range": "Mon, 17 Aug 2099 12:34:56 GMT" }), false],
      [new Headers({ "If-Range": "Mon, 17 Aug 2020 12:34:56 GMT" }), false],
      [new Headers({ "If-Range": "not a date" }), false],
      [new Headers({ "If-Range": `, "${PROVIDER_ETAG}",` }), false],
    ];
    for (const [headers, useRange] of cases) {
      expect(evaluateNativeStorageClientConditionals(headers, SNAPSHOT, true)).toEqual({
        outcome: "proceed",
        useRange,
      });
    }
    expect(evaluateNativeStorageClientConditionals(new Headers(), SNAPSHOT, false)).toEqual({
      outcome: "proceed",
      useRange: false,
    });
  });
});

describe("native storage private headers", () => {
  test("emits only the fixed private response header allowlist", () => {
    const headers = buildNativeStoragePrivateHeaders(SNAPSHOT);
    expect(Object.fromEntries(headers)).toEqual({
      "accept-ranges": "bytes",
      "cache-control": "private, no-store, max-age=0, no-transform",
      "content-length": "10",
      "content-security-policy": "default-src 'none'; sandbox; frame-ancestors 'none'",
      "content-type": "text/plain; charset=utf-8",
      "cross-origin-resource-policy": "same-origin",
      etag: `"${PROVIDER_ETAG}"`,
      "last-modified": "Mon, 17 Aug 2026 12:34:56 GMT",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });
    expect(headers.has("access-control-allow-origin")).toBe(false);
  });

  test("adds exact range headers and forces attachment for active or unknown content", () => {
    const range = resolvedRange("bytes=2-5");
    const active = buildNativeStoragePrivateHeaders(
      { ...SNAPSHOT, contentType: "text/html" },
      range,
    );
    expect(active.get("content-length")).toBe("4");
    expect(active.get("content-range")).toBe("bytes 2-5/10");
    expect(active.get("content-disposition")).toBe("attachment");
    expect(
      buildNativeStoragePrivateHeaders({ ...SNAPSHOT, contentType: "application/x-unknown" }).get(
        "content-disposition",
      ),
    ).toBe("attachment");
    expect(buildNativeStoragePrivateHeaders(SNAPSHOT).has("content-disposition")).toBe(false);
  });
});

describe("native storage HEAD evidence", () => {
  test("requires the exact catalog key, version, ETag, size, type, upload time, and checksum", async () => {
    const bucket = new FakeRuntimeR2Bucket();
    await expect(verifyNativeStorageHead(bucket, SNAPSHOT)).resolves.toBeUndefined();
    expect(bucket.headCalls).toEqual([PROVIDER_KEY]);

    const mismatches: Array<[string, Partial<RuntimeR2ObjectMetadata>]> = [
      ["key", { key: `${PROVIDER_KEY}-other` }],
      ["same ETag with a new version", { version: `${PROVIDER_VERSION}-new` }],
      ["etag", { etag: `${PROVIDER_ETAG}-new` }],
      ["httpEtag", { httpEtag: `"${PROVIDER_ETAG}-new"` }],
      ["size", { size: 11 }],
      ["contentType", { httpMetadata: { contentType: "text/html" } }],
      ["uploaded", { uploaded: new Date(UPLOADED_AT.getTime() + 1_000) }],
      ["checksum", { checksums: { sha256: new Uint8Array(32).fill(255).buffer } }],
      ["unexpected range", { range: { offset: 0, length: 10 } }],
    ];
    for (const [, override] of mismatches) {
      bucket.headResult = metadata(override);
      await expectReadError(
        verifyNativeStorageHead(bucket, SNAPSHOT),
        "NATIVE_STORAGE_PROVIDER_EVIDENCE_MISMATCH",
      );
    }
  });

  test("maps missing bindings, provider throws, and null results to static typed errors", async () => {
    const withoutHead = {
      async get() {
        return null;
      },
      async put() {
        return {};
      },
      async delete() {
        return {};
      },
    } satisfies RuntimeR2Bucket;
    await expectReadError(
      verifyNativeStorageHead(withoutHead, SNAPSHOT),
      "NATIVE_STORAGE_BINDING_CONTRACT_UNAVAILABLE",
    );

    const bucket = new FakeRuntimeR2Bucket();
    bucket.headError = new Error(`provider exploded for ${PROVIDER_KEY}`);
    await expectReadError(
      verifyNativeStorageHead(bucket, SNAPSHOT),
      "NATIVE_STORAGE_PROVIDER_READ_FAILED",
      [PROVIDER_KEY, "provider exploded"],
    );
    bucket.headError = null;
    bucket.headResult = null;
    await expectReadError(
      verifyNativeStorageHead(bucket, SNAPSHOT),
      "NATIVE_STORAGE_PROVIDER_OBJECT_MISSING",
    );
  });
});

describe("native storage GET transport", () => {
  test("uses an exact ETag condition and transfers the original stream without buffering", async () => {
    const bucket = new FakeRuntimeR2Bucket();
    const body = new TrackingReadableStream();
    const text = mock(async () => "must not run");
    const arrayBuffer = mock(async () => new ArrayBuffer(0));
    bucket.getResult = responseObject(body, { text, arrayBuffer });

    const opened = await openNativeStorageGet(bucket, SNAPSHOT);
    expect(opened.body).toBe(body);
    expect(opened.range).toBeNull();
    expect(bucket.getCalls).toEqual([
      { key: PROVIDER_KEY, options: { onlyIf: { etagMatches: PROVIDER_ETAG } } },
    ]);
    expect(text).not.toHaveBeenCalled();
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(body.cancelAttempts).toBe(0);
  });

  test("passes an offset/length range and verifies the provider's returned range", async () => {
    const bucket = new FakeRuntimeR2Bucket();
    const range = resolvedRange("bytes=2-5");
    const body = new TrackingReadableStream();
    bucket.getResult = responseObject(body, { range: { offset: 2, length: 4 } });

    const opened = await openNativeStorageGet(bucket, SNAPSHOT, range);
    expect(opened.body).toBe(body);
    expect(opened.range).toEqual(range);
    expect(opened.range).not.toBe(range);
    expect(opened.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(bucket.getCalls[0]).toEqual({
      key: PROVIDER_KEY,
      options: {
        onlyIf: { etagMatches: PROVIDER_ETAG },
        range: { offset: 2, length: 4 },
      },
    });
  });

  test("cancels every streamed evidence mismatch, including same ETag/new version", async () => {
    const mismatches: Array<[string, Partial<RuntimeR2Object>]> = [
      ["key", { key: `${PROVIDER_KEY}-other` }],
      ["same ETag with a new version", { version: `${PROVIDER_VERSION}-new` }],
      ["etag", { etag: `${PROVIDER_ETAG}-new` }],
      ["httpEtag", { httpEtag: `"${PROVIDER_ETAG}-new"` }],
      ["size", { size: 11 }],
      ["contentType", { httpMetadata: { contentType: "text/html" } }],
      ["uploaded", { uploaded: new Date(UPLOADED_AT.getTime() + 1_000) }],
      ["checksum", { checksums: { sha256: new Uint8Array(32).fill(255).buffer } }],
      ["unexpected range", { range: { offset: 0, length: 10 } }],
    ];
    for (const [, override] of mismatches) {
      const bucket = new FakeRuntimeR2Bucket();
      const body = new TrackingReadableStream();
      bucket.getResult = responseObject(body, override);
      await expectReadError(
        openNativeStorageGet(bucket, SNAPSHOT),
        "NATIVE_STORAGE_PROVIDER_EVIDENCE_MISMATCH",
      );
      expect(body.cancelAttempts).toBe(1);
    }
  });

  test("rejects forged resolved ranges before provider I/O", async () => {
    const bucket = new FakeRuntimeR2Bucket();
    const forged: NativeStorageResolvedRange = {
      offset: 0,
      length: 1,
      end: 9,
      contentRange: "bytes 0-999/10\r\nx-injected: true",
    };
    await expectReadError(
      openNativeStorageGet(bucket, SNAPSHOT, forged),
      "NATIVE_STORAGE_INVALID_RANGE",
      [forged.contentRange],
    );
    expect(bucket.getCalls).toHaveLength(0);
    expect(() => buildNativeStoragePrivateHeaders(SNAPSHOT, forged)).toThrow(
      expect.objectContaining({ code: "NATIVE_STORAGE_INVALID_RANGE" }),
    );
  });

  test("cancels a mismatched provider response range", async () => {
    const bucket = new FakeRuntimeR2Bucket();
    const body = new TrackingReadableStream();
    const requested = resolvedRange("bytes=2-5");
    bucket.getResult = responseObject(body, { range: { offset: 3, length: 4 } });
    await expectReadError(
      openNativeStorageGet(bucket, SNAPSHOT, requested),
      "NATIVE_STORAGE_PROVIDER_EVIDENCE_MISMATCH",
    );
    expect(body.cancelAttempts).toBe(1);
  });

  test("maps null, bodyless conditional, and provider throws to privacy-safe errors", async () => {
    const bucket = new FakeRuntimeR2Bucket();
    bucket.getResult = null;
    await expectReadError(
      openNativeStorageGet(bucket, SNAPSHOT),
      "NATIVE_STORAGE_PROVIDER_OBJECT_MISSING",
    );

    bucket.getResult = metadata({ version: `${PROVIDER_VERSION}-changed` });
    await expectReadError(
      openNativeStorageGet(bucket, SNAPSHOT),
      "NATIVE_STORAGE_PROVIDER_CONDITION_FAILED",
    );

    bucket.getError = new Error(`R2 rejected ${OBJECT_KEY} ${PROVIDER_ETAG}`);
    const error = await expectReadError(
      openNativeStorageGet(bucket, SNAPSHOT),
      "NATIVE_STORAGE_PROVIDER_READ_FAILED",
      [OBJECT_KEY, PROVIDER_ETAG, "R2 rejected"],
    );
    expect(String(error.cause)).not.toContain(OBJECT_KEY);
    expect(String(error.cause)).not.toContain(PROVIDER_ETAG);
  });

  test("rejects and cancels bodyUsed and locked streams", async () => {
    const usedBucket = new FakeRuntimeR2Bucket();
    const usedBody = new TrackingReadableStream();
    usedBucket.getResult = responseObject(usedBody, { bodyUsed: true });
    await expectReadError(
      openNativeStorageGet(usedBucket, SNAPSHOT),
      "NATIVE_STORAGE_PROVIDER_STREAM_UNUSABLE",
    );
    expect(usedBody.cancelAttempts).toBe(1);

    const lockedBucket = new FakeRuntimeR2Bucket();
    const lockedBody = new TrackingReadableStream();
    const reader = lockedBody.getReader();
    lockedBucket.getResult = responseObject(lockedBody);
    const lockedError = await expectReadError(
      openNativeStorageGet(lockedBucket, SNAPSHOT),
      "NATIVE_STORAGE_PROVIDER_STREAM_UNUSABLE",
    );
    expect(lockedBody.cancelAttempts).toBe(1);
    expect(lockedError.cause).toMatchObject({
      code: "NATIVE_STORAGE_PROVIDER_CANCEL_FAILED",
      message: "Native storage provider body cancellation failed.",
    });
    expect(lockedBody.locked).toBe(true);
    reader.releaseLock();
  });

  test("awaits cancellation before rejecting an evidence failure", async () => {
    let releaseCancel: (() => void) | undefined;
    let cancelAttempts = 0;
    class DelayedCancelStream extends ReadableStream<Uint8Array> {
      override cancel(): Promise<void> {
        cancelAttempts += 1;
        return new Promise<void>((resolve) => {
          releaseCancel = resolve;
        });
      }
    }
    const bucket = new FakeRuntimeR2Bucket();
    bucket.getResult = responseObject(new DelayedCancelStream(), { size: 11 });
    let settled = false;
    const pending = openNativeStorageGet(bucket, SNAPSHOT).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelAttempts).toBe(1);
    expect(settled).toBe(false);
    releaseCancel?.();
    await expectReadError(pending, "NATIVE_STORAGE_PROVIDER_EVIDENCE_MISMATCH");
    expect(settled).toBe(true);
  });

  test("never forwards malicious provider HTTP metadata", async () => {
    const bucket = new FakeRuntimeR2Bucket();
    bucket.getResult = responseObject(new TrackingReadableStream(), {
      httpMetadata: {
        contentType: SNAPSHOT.contentType,
        cacheControl: "public, max-age=31536000",
        contentDisposition: 'inline; filename="attack.html"',
        contentLanguage: "x-attack",
        contentEncoding: "gzip",
      },
    });
    const opened = await openNativeStorageGet(bucket, SNAPSHOT);
    expect(opened.headers.get("cache-control")).toBe("private, no-store, max-age=0, no-transform");
    expect(opened.headers.has("content-disposition")).toBe(false);
    expect(opened.headers.has("content-language")).toBe(false);
    expect(opened.headers.has("content-encoding")).toBe(false);
  });

  test("rejects invalid snapshots with a static error", async () => {
    const invalid = { ...SNAPSHOT, providerKey: "../private-object" };
    await expectReadError(
      openNativeStorageGet(new FakeRuntimeR2Bucket(), invalid),
      "NATIVE_STORAGE_INVALID_SNAPSHOT",
      [invalid.providerKey, invalid.objectKey],
    );

    for (const malformed of [
      { ...SNAPSHOT, providerVersion: null },
      { ...SNAPSHOT, providerEtag: 7 },
      { ...SNAPSHOT, committedGeneration: "7" },
      { ...SNAPSHOT, sizeBytes: Number.NaN },
      { ...SNAPSHOT, providerUploadedAt: "2026-08-17" },
    ]) {
      const promise = Reflect.apply(openNativeStorageGet, undefined, [
        new FakeRuntimeR2Bucket(),
        malformed,
      ]);
      await expectReadError(promise, "NATIVE_STORAGE_INVALID_SNAPSHOT");
    }
  });
});
