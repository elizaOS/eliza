/**
 * Covers the TEE attestation-evidence normalizer and digest helpers:
 * isTeeEvidence, normalizeTeeEvidence, teeMeasurementDigestMatches, and
 * normalizeDigest. Asserts boundary validation, optional-field omission, and
 * digest comparison over the real module — no mocks.
 */
import { describe, expect, it } from "vitest";
import {
  isTeeEvidence,
  normalizeDigest,
  normalizeTeeEvidence,
  teeMeasurementDigestMatches,
} from "./tee-evidence.ts";

describe("isTeeEvidence", () => {
  it("rejects non-objects, arrays, and null", () => {
    expect(isTeeEvidence(undefined)).toBe(false);
    expect(isTeeEvidence(null)).toBe(false);
    expect(isTeeEvidence("tdx")).toBe(false);
    expect(isTeeEvidence(1)).toBe(false);
    expect(isTeeEvidence(true)).toBe(false);
    expect(isTeeEvidence([{ kind: "tdx" }])).toBe(false);
  });

  it("rejects a record whose kind is missing, non-string, or blank", () => {
    expect(isTeeEvidence({})).toBe(false);
    expect(isTeeEvidence({ kind: 1 })).toBe(false);
    expect(isTeeEvidence({ kind: "" })).toBe(false);
    expect(isTeeEvidence({ kind: "   " })).toBe(false);
  });

  it("accepts a record with a non-empty kind string, ignoring other fields", () => {
    expect(isTeeEvidence({ kind: "tdx" })).toBe(true);
    expect(isTeeEvidence({ kind: "  cove  " })).toBe(true);
    expect(
      isTeeEvidence({ kind: "custom-vendor", measurements: "not-an-object" }),
    ).toBe(true);
  });
});

describe("normalizeTeeEvidence", () => {
  it("throws when the value is not a record", () => {
    expect(() => normalizeTeeEvidence(undefined)).toThrow(
      "TEE evidence must be an object.",
    );
    expect(() => normalizeTeeEvidence(null)).toThrow(
      "TEE evidence must be an object.",
    );
    expect(() => normalizeTeeEvidence([])).toThrow(
      "TEE evidence must be an object.",
    );
    expect(() => normalizeTeeEvidence("tdx")).toThrow(
      "TEE evidence must be an object.",
    );
  });

  it("requires a non-empty trimmed kind string", () => {
    expect(() => normalizeTeeEvidence({})).toThrow(
      'TEE evidence field "kind" is required.',
    );
    expect(() => normalizeTeeEvidence({ kind: "" })).toThrow(
      'TEE evidence field "kind" is required.',
    );
    expect(() => normalizeTeeEvidence({ kind: "   " })).toThrow(
      'TEE evidence field "kind" is required.',
    );
    expect(() => normalizeTeeEvidence({ kind: 7 })).toThrow(
      'TEE evidence field "kind" must be a string.',
    );
  });

  it("returns kind plus raw and omits empty optional fields", () => {
    const input = { kind: "  tdx  " };
    expect(normalizeTeeEvidence(input)).toEqual({
      kind: "tdx",
      raw: input,
    });
  });

  it("trims optional strings and omits blank ones", () => {
    const input = {
      kind: "nitro",
      provider: "  dstack  ",
      hardwareVendor: "intel",
      platformVersion: "",
      quote: "   ",
      certificatePem: "-----BEGIN CERT-----\n",
      reportData: "aabb",
    };
    expect(normalizeTeeEvidence(input)).toEqual({
      kind: "nitro",
      provider: "dstack",
      hardwareVendor: "intel",
      certificatePem: "-----BEGIN CERT-----",
      reportData: "aabb",
      raw: input,
    });
  });

  it("rejects a non-string optional string field", () => {
    expect(() => normalizeTeeEvidence({ kind: "tdx", provider: 1 })).toThrow(
      'TEE evidence field "provider" must be a string.',
    );
    expect(() => normalizeTeeEvidence({ kind: "tdx", quote: true })).toThrow(
      'TEE evidence field "quote" must be a string.',
    );
  });

  it("keeps integer securityVersion including zero and negatives", () => {
    const zero = { kind: "tdx", securityVersion: 0 };
    expect(normalizeTeeEvidence(zero)).toEqual({
      kind: "tdx",
      securityVersion: 0,
      raw: zero,
    });
    const negative = { kind: "tdx", securityVersion: -1 };
    expect(normalizeTeeEvidence(negative)).toEqual({
      kind: "tdx",
      securityVersion: -1,
      raw: negative,
    });
  });

  it("rejects a non-integer securityVersion", () => {
    expect(() =>
      normalizeTeeEvidence({ kind: "tdx", securityVersion: 1.5 }),
    ).toThrow('TEE evidence field "securityVersion" must be an integer.');
    expect(() =>
      normalizeTeeEvidence({ kind: "tdx", securityVersion: Number.NaN }),
    ).toThrow('TEE evidence field "securityVersion" must be an integer.');
    expect(() =>
      normalizeTeeEvidence({ kind: "tdx", securityVersion: "7" }),
    ).toThrow('TEE evidence field "securityVersion" must be an integer.');
  });

  it("normalizes measurements, dropping blank values and empty maps", () => {
    const empty = { kind: "tdx", measurements: {} };
    expect(normalizeTeeEvidence(empty)).toEqual({ kind: "tdx", raw: empty });

    const blanks = { kind: "tdx", measurements: { boot: "  ", os: "" } };
    expect(normalizeTeeEvidence(blanks)).toEqual({ kind: "tdx", raw: blanks });

    const mixed = {
      kind: "tdx",
      measurements: {
        boot: "  ABC  ",
        os: "",
        customProbe: "deadbeef",
      },
    };
    expect(normalizeTeeEvidence(mixed)).toEqual({
      kind: "tdx",
      measurements: { boot: "ABC", customProbe: "deadbeef" },
      raw: mixed,
    });
  });

  it("rejects non-object measurements and non-string measurement values", () => {
    expect(() =>
      normalizeTeeEvidence({ kind: "tdx", measurements: "boot" }),
    ).toThrow("TEE evidence measurements must be an object.");
    expect(() =>
      normalizeTeeEvidence({ kind: "tdx", measurements: [] }),
    ).toThrow("TEE evidence measurements must be an object.");
    expect(() =>
      normalizeTeeEvidence({ kind: "tdx", measurements: { boot: 1 } }),
    ).toThrow('TEE measurement "boot" must be a string.');
  });

  it("normalizes freshness, dropping empty maps and unknown keys", () => {
    const empty = { kind: "tdx", freshness: {} };
    expect(normalizeTeeEvidence(empty)).toEqual({ kind: "tdx", raw: empty });

    const blanks = {
      kind: "tdx",
      freshness: { nonce: "  ", timestamp: "", extra: "ignored" },
    };
    expect(normalizeTeeEvidence(blanks)).toEqual({ kind: "tdx", raw: blanks });

    const full = {
      kind: "tdx",
      freshness: {
        nonce: "  n1  ",
        timestamp: "2026-05-20T12:00:00.000Z",
        verifier: "intel-pcs",
      },
    };
    expect(normalizeTeeEvidence(full)).toEqual({
      kind: "tdx",
      freshness: {
        nonce: "n1",
        timestamp: "2026-05-20T12:00:00.000Z",
        verifier: "intel-pcs",
      },
      raw: full,
    });
  });

  it("rejects non-object freshness", () => {
    expect(() =>
      normalizeTeeEvidence({ kind: "tdx", freshness: "now" }),
    ).toThrow("TEE evidence freshness must be an object.");
  });

  it("normalizes known boolean claims and ignores unknown keys", () => {
    const empty = { kind: "tdx", claims: { extra: true } };
    expect(normalizeTeeEvidence(empty)).toEqual({ kind: "tdx", raw: empty });

    const mixed = {
      kind: "tdx",
      claims: {
        debugDisabled: true,
        productionLifecycle: false,
        extra: true,
      },
    };
    expect(normalizeTeeEvidence(mixed)).toEqual({
      kind: "tdx",
      claims: {
        debugDisabled: true,
        productionLifecycle: false,
      },
      raw: mixed,
    });
  });

  it("copies every recognized claim key when boolean", () => {
    const input = {
      kind: "cove",
      claims: {
        debugDisabled: true,
        productionLifecycle: true,
        secureBoot: true,
        memoryEncrypted: true,
        ioProtected: true,
        gpuProtected: false,
        npuProtected: true,
        monitorMeasured: true,
      },
    };
    expect(normalizeTeeEvidence(input).claims).toEqual(input.claims);
  });

  it("rejects non-object claims and non-boolean recognized claim values", () => {
    expect(() => normalizeTeeEvidence({ kind: "tdx", claims: [] })).toThrow(
      "TEE evidence claims must be an object.",
    );
    expect(() =>
      normalizeTeeEvidence({ kind: "tdx", claims: { debugDisabled: "yes" } }),
    ).toThrow('TEE claim "debugDisabled" must be boolean.');
  });

  it("preserves the original input as raw, including extra fields", () => {
    const input = { kind: "none", extra: 42 };
    const evidence = normalizeTeeEvidence(input);
    expect(evidence.raw).toBe(input);
    expect(evidence).toEqual({ kind: "none", raw: input });
  });
});

describe("normalizeDigest", () => {
  it("trims, lowercases, and strips a leading sha256: prefix", () => {
    expect(normalizeDigest("  SHA256:AbC  ")).toBe("abc");
    expect(normalizeDigest("sha256:deadbeef")).toBe("deadbeef");
    expect(normalizeDigest("DEADBEEF")).toBe("deadbeef");
  });

  it("does not strip sha256: when it is not a prefix", () => {
    expect(normalizeDigest("digest-sha256:tail")).toBe("digest-sha256:tail");
  });
});

describe("teeMeasurementDigestMatches", () => {
  it("treats an undefined expected digest as a match", () => {
    expect(teeMeasurementDigestMatches(undefined, undefined)).toBe(true);
    expect(teeMeasurementDigestMatches("abc", undefined)).toBe(true);
  });

  it("rejects a missing actual when expected is defined, including empty string", () => {
    expect(teeMeasurementDigestMatches(undefined, "abc")).toBe(false);
    expect(teeMeasurementDigestMatches(undefined, "")).toBe(false);
  });

  it("compares after digest normalization, so prefix and case do not matter", () => {
    expect(teeMeasurementDigestMatches("  SHA256:AbC  ", "sha256:abc")).toBe(
      true,
    );
    expect(teeMeasurementDigestMatches("abc", "sha256:abc")).toBe(true);
    expect(teeMeasurementDigestMatches("aaa", "bbb")).toBe(false);
  });
});
