/**
 * Contract tests for the schema-1 manifest/meta validators: round-trips,
 * per-field rejection, and path-traversal hardening. Real values only — no
 * mocks; the validators under test are the runtime boundary itself.
 */

import { describe, expect, it } from "vitest";
import { EvidenceValidationError } from "./errors.ts";
import {
  type ArtifactEntry,
  type BundleManifest,
  type BundleMeta,
  isBundleRelativePath,
  parseManifest,
  parseMeta,
} from "./schema.ts";

const SHA = "a".repeat(64);

function validEntry(overrides: Partial<ArtifactEntry> = {}): ArtifactEntry {
  return {
    path: "visual/aesthetic-audit/desktop/home.png",
    sha256: SHA,
    bytes: 1234,
    kind: "screenshot",
    source: "aesthetic-audit",
    lane: "e2e",
    producedBy: "packages/app audit:app",
    createdAt: "2026-07-05T12:00:00.000Z",
    ...overrides,
  };
}

function validManifest(
  overrides: Partial<BundleManifest> = {},
): BundleManifest {
  return {
    schema: 1,
    runId: "20260705-120000-abcdef0-cpu",
    createdAt: "2026-07-05T12:00:00.000Z",
    metaSha256: "b".repeat(64),
    artifacts: [validEntry()],
    ...overrides,
  };
}

function validMeta(overrides: Partial<BundleMeta> = {}): BundleMeta {
  return {
    schema: 1,
    runId: "20260705-120000-abcdef0-cpu",
    commit: "abcdef0123456789abcdef0123456789abcdef01",
    branch: "feat/14552-evidence-bundle",
    runner: "local",
    tier: "cpu",
    startedAt: "2026-07-05T12:00:00.000Z",
    finishedAt: "2026-07-05T12:05:00.000Z",
    envFingerprint: {
      node: "v24.0.0",
      platform: "darwin",
      arch: "arm64",
      tier: "cpu",
    },
    timings: { "ingest.all": 1500 },
    ...overrides,
  };
}

describe("parseManifest", () => {
  it("round-trips a valid manifest through JSON", () => {
    const manifest = validManifest();
    const parsed = parseManifest(JSON.parse(JSON.stringify(manifest)), "test");
    expect(parsed).toEqual(manifest);
  });

  it("accepts an entry without the optional lane", () => {
    const entry = validEntry();
    delete (entry as Partial<ArtifactEntry>).lane;
    const parsed = parseManifest(
      JSON.parse(JSON.stringify(validManifest({ artifacts: [entry] }))),
      "test",
    );
    expect(parsed.artifacts[0].lane).toBeUndefined();
  });

  it.each([
    ["missing runId", () => ({ ...validManifest(), runId: undefined })],
    ["wrong schema version", () => ({ ...validManifest(), schema: 2 })],
    ["non-array artifacts", () => ({ ...validManifest(), artifacts: {} })],
    ["unknown top-level key", () => ({ ...validManifest(), extra: true })],
    [
      "missing metaSha256",
      () => ({ ...validManifest(), metaSha256: undefined }),
    ],
    [
      "non-hex metaSha256",
      () => ({ ...validManifest(), metaSha256: "Z".repeat(64) }),
    ],
  ])("rejects a manifest with %s", (_label, make) => {
    expect(() =>
      parseManifest(JSON.parse(JSON.stringify(make())), "test"),
    ).toThrow(EvidenceValidationError);
  });

  it.each([
    ["bad kind", validEntry({ kind: "gif" as ArtifactEntry["kind"] })],
    ["uppercase sha256", validEntry({ sha256: "A".repeat(64) })],
    ["short sha256", validEntry({ sha256: "abc123" })],
    ["negative bytes", validEntry({ bytes: -1 })],
    ["fractional bytes", validEntry({ bytes: 1.5 })],
    ["empty source", validEntry({ source: "" })],
    ["empty producedBy", validEntry({ producedBy: "" })],
    ["non-timestamp createdAt", validEntry({ createdAt: "yesterday" })],
  ])("rejects an entry with %s", (_label, entry) => {
    expect(() =>
      parseManifest(
        JSON.parse(JSON.stringify(validManifest({ artifacts: [entry] }))),
        "test",
      ),
    ).toThrow(EvidenceValidationError);
  });

  it.each([
    ["traversal", "../escape.png"],
    ["nested traversal", "visual/../../escape.png"],
    ["absolute", "/etc/passwd"],
    ["backslash", "visual\\home.png"],
    ["dot segment", "visual/./home.png"],
    ["empty segment", "visual//home.png"],
    ["empty path", ""],
  ])("rejects an entry path with %s (%s)", (_label, badPath) => {
    expect(isBundleRelativePath(badPath)).toBe(false);
    expect(() =>
      parseManifest(
        JSON.parse(
          JSON.stringify(
            validManifest({ artifacts: [validEntry({ path: badPath })] }),
          ),
        ),
        "test",
      ),
    ).toThrow(EvidenceValidationError);
  });

  it("rejects duplicate artifact paths", () => {
    const manifest = validManifest({ artifacts: [validEntry(), validEntry()] });
    expect(() =>
      parseManifest(JSON.parse(JSON.stringify(manifest)), "test"),
    ).toThrow(/duplicate artifact path/);
  });

  it("reports every issue with its dotted path", () => {
    const manifest = validManifest({
      artifacts: [validEntry({ sha256: "nope", bytes: -2 })],
    });
    try {
      parseManifest(JSON.parse(JSON.stringify(manifest)), "test");
      expect.unreachable("should have thrown");
    } catch (error) {
      const validation = error as EvidenceValidationError;
      expect(validation).toBeInstanceOf(EvidenceValidationError);
      expect(validation.code).toBe("MANIFEST_INVALID");
      const paths = validation.issues.map((issue) => issue.path);
      expect(paths).toContain("artifacts.0.sha256");
      expect(paths).toContain("artifacts.0.bytes");
    }
  });
});

describe("parseMeta", () => {
  it("round-trips valid meta through JSON", () => {
    const meta = validMeta();
    expect(parseMeta(JSON.parse(JSON.stringify(meta)), "test")).toEqual(meta);
  });

  it("accepts meta without optional finishedAt/timings", () => {
    const meta = validMeta();
    delete (meta as Partial<BundleMeta>).finishedAt;
    delete (meta as Partial<BundleMeta>).timings;
    expect(parseMeta(JSON.parse(JSON.stringify(meta)), "test")).toEqual(meta);
  });

  it.each([
    ["bad runner", validMeta({ runner: "docker" as BundleMeta["runner"] })],
    ["bad tier", validMeta({ tier: "tpu" as BundleMeta["tier"] })],
    ["non-hex commit", validMeta({ commit: "not-a-sha" })],
    ["empty branch", validMeta({ branch: "" })],
    [
      "non-string fingerprint value",
      validMeta({
        envFingerprint: { node: 24 } as unknown as Record<string, string>,
      }),
    ],
  ])("rejects meta with %s", (_label, meta) => {
    expect(() => parseMeta(JSON.parse(JSON.stringify(meta)), "test")).toThrow(
      EvidenceValidationError,
    );
  });
});
