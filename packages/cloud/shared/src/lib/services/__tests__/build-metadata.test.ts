// Exercises the buildx metadata-file digest parsing logic that captures the
// pushed image digest atomically from the same build invocation (#13097), so a
// concurrent build or registry retag can never produce a wrong digest. These
// are pure functions operating on the raw JSON buildx writes to --metadata-file;
// the impure file read lives in AppImageBuilder and is exercised separately.
import { describe, expect, test } from "bun:test";
import { ElizaError } from "@elizaos/core";
import { BuildMetadataError, buildDigestPinnedRef, parseBuildxDigest } from "../build-metadata";

const VALID_DIGEST = "sha256:a1b32e421ac1a7a3b3e1485fa34ceced6dec756893baf8bc9022298c3f6d0f88";

describe("parseBuildxDigest", () => {
  test("extracts a valid sha256 digest from buildx metadata JSON", () => {
    const raw = JSON.stringify({
      "containerimage.digest": VALID_DIGEST,
      "containerimage.config.digest": "sha256:other",
    });
    expect(parseBuildxDigest(raw)).toBe(VALID_DIGEST);
  });

  test("throws BuildMetadataError when the file is not valid JSON", () => {
    expect(() => parseBuildxDigest("not json")).toThrow(BuildMetadataError);
    expect(() => parseBuildxDigest("not json")).toThrow(/not valid JSON/);
  });

  test("throws BuildMetadataError when the JSON is not an object", () => {
    expect(() => parseBuildxDigest("[]")).toThrow(BuildMetadataError);
    expect(() => parseBuildxDigest("null")).toThrow(BuildMetadataError);
    expect(() => parseBuildxDigest('"string"')).toThrow(BuildMetadataError);
    expect(() => parseBuildxDigest("42")).toThrow(BuildMetadataError);
  });

  test("throws BuildMetadataError when containerimage.digest is missing", () => {
    expect(() => parseBuildxDigest(JSON.stringify({ foo: "bar" }))).toThrow(BuildMetadataError);
    expect(() => parseBuildxDigest(JSON.stringify({ foo: "bar" }))).toThrow(/missing or invalid/);
  });

  test("throws BuildMetadataError when the digest is malformed", () => {
    expect(() =>
      parseBuildxDigest(JSON.stringify({ "containerimage.digest": "not-a-digest" })),
    ).toThrow(BuildMetadataError);
    expect(() =>
      parseBuildxDigest(JSON.stringify({ "containerimage.digest": "sha256:short" })),
    ).toThrow(BuildMetadataError);
    expect(() =>
      parseBuildxDigest(JSON.stringify({ "containerimage.digest": "sha256:GG".repeat(32) })),
    ).toThrow(BuildMetadataError);
    expect(() => parseBuildxDigest(JSON.stringify({ "containerimage.digest": 42 }))).toThrow(
      BuildMetadataError,
    );
  });

  test("preserves the cause chain when JSON.parse fails", () => {
    try {
      parseBuildxDigest("not json");
    } catch (error) {
      expect(error).toBeInstanceOf(BuildMetadataError);
      expect((error as Error).cause).toBeDefined();
    }
  });

  test("BuildMetadataError extends ElizaError with a stable code (#13097 P2 fix)", () => {
    try {
      parseBuildxDigest("not json");
    } catch (error) {
      expect(error).toBeInstanceOf(BuildMetadataError);
      expect(error).toBeInstanceOf(ElizaError);
      const elizaErr = error as ElizaError;
      expect(elizaErr.code).toBe("BUILD_METADATA_DIGEST_NOT_CAPTURED");
      expect(elizaErr.severity).toBe("fatal");
    }
  });
});

describe("buildDigestPinnedRef", () => {
  test("constructs a repo@sha256 ref from a tagged ref + digest", () => {
    const result = buildDigestPinnedRef("ghcr.io/elizaos/app-demo:v1", VALID_DIGEST);
    expect(result).toBe(`ghcr.io/elizaos/app-demo@${VALID_DIGEST}`);
  });

  test("strips an implicit-latest ref (no tag) and pins the digest", () => {
    const result = buildDigestPinnedRef("ghcr.io/elizaos/app-demo", VALID_DIGEST);
    expect(result).toBe(`ghcr.io/elizaos/app-demo@${VALID_DIGEST}`);
  });

  test("strips an existing @digest before pinning the new one", () => {
    const result = buildDigestPinnedRef(
      `ghcr.io/elizaos/app-demo@sha256:${"a".repeat(64)}`,
      VALID_DIGEST,
    );
    expect(result).toBe(`ghcr.io/elizaos/app-demo@${VALID_DIGEST}`);
  });

  test("handles registry with port", () => {
    const result = buildDigestPinnedRef("registry.local:5000/app:v1", VALID_DIGEST);
    expect(result).toBe(`registry.local:5000/app@${VALID_DIGEST}`);
  });

  test("throws on an invalid digest", () => {
    expect(() => buildDigestPinnedRef("ghcr.io/elizaos/app:v1", "not-a-digest")).toThrow(
      /invalid digest/,
    );
  });
});
