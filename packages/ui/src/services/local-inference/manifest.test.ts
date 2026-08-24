/**
 * Unit tests for the Eliza-1 manifest parser surface in services/local-inference/manifest.
 * Validates parseManifestOrThrow acceptance of well-formed manifests, its typed rejection
 * branches for untrusted input, and the exact lenient boundary the bundle picker relies on.
 * Harness is deterministic and pure: no filesystem, network, mocks, or clocks.
 */

import { describe, expect, it } from "vitest";
import type { Eliza1FileEntry, Eliza1Manifest } from "./manifest.js";
import { parseManifestOrThrow } from "./manifest.js";

function createFileEntry(path: string): Eliza1FileEntry {
  return { path, sizeBytes: 1024, sha256: "a".repeat(64) };
}

function createValidManifest(): Eliza1Manifest {
  return {
    id: "eliza-1-2b",
    version: "1.0.0",
    tier: "2b",
    ramBudgetMb: { min: 4096 },
    kernels: {
      verifiedBackends: {
        cpu: { status: "pass" },
        metal: { status: "pass" },
        cuda: { status: "fail" },
        vulkan: { status: "skip" },
        rocm: { status: "skip" },
      },
    },
    files: {
      text: [createFileEntry("models/text.gguf")],
      voice: [createFileEntry("models/voice.gguf")],
      cache: [createFileEntry("cache/kv.bin")],
    },
  };
}

describe("local-inference manifest", () => {
  describe("parseManifestOrThrow", () => {
    it("accepts a complete manifest and preserves its values", () => {
      const manifest = createValidManifest();
      const parsed = parseManifestOrThrow(manifest);
      expect(parsed.id).toBe("eliza-1-2b");
      expect(parsed.version).toBe("1.0.0");
      expect(parsed.tier).toBe("2b");
      expect(parsed.ramBudgetMb.min).toBe(4096);
      expect(parsed.files.text).toHaveLength(1);
      expect(parsed.kernels.verifiedBackends.cpu.status).toBe("pass");
    });

    it("rejects scalar input with the expected-object error", () => {
      expect(() => parseManifestOrThrow(null)).toThrow(
        "Invalid Eliza-1 manifest: expected object",
      );
      expect(() => parseManifestOrThrow("eliza-1")).toThrow(
        "Invalid Eliza-1 manifest: expected object",
      );
      expect(() => parseManifestOrThrow(42)).toThrow(
        "Invalid Eliza-1 manifest: expected object",
      );
      expect(() => parseManifestOrThrow(undefined)).toThrow(
        "Invalid Eliza-1 manifest: expected object",
      );
    });

    it("rejects an array because it carries no manifest fields", () => {
      expect(() => parseManifestOrThrow([createValidManifest()])).toThrow(
        "Invalid Eliza-1 manifest: missing id or version",
      );
    });

    it("rejects a manifest whose id is missing", () => {
      const manifest = createValidManifest();
      delete (manifest as Partial<Eliza1Manifest>).id;
      expect(() => parseManifestOrThrow(manifest)).toThrow(
        "Invalid Eliza-1 manifest: missing id or version",
      );
    });

    it("rejects a manifest whose version is not a string", () => {
      const manifest = createValidManifest() as unknown as Record<
        string,
        unknown
      >;
      manifest.version = 3;
      expect(() => parseManifestOrThrow(manifest)).toThrow(
        "Invalid Eliza-1 manifest: missing id or version",
      );
    });

    it("rejects a manifest with no files section", () => {
      const manifest = createValidManifest() as unknown as Record<
        string,
        unknown
      >;
      delete manifest.files;
      expect(() => parseManifestOrThrow(manifest)).toThrow(
        "Invalid Eliza-1 manifest: missing required files or RAM budget",
      );
    });

    it("rejects a manifest whose text file list is empty", () => {
      const manifest = createValidManifest();
      manifest.files.text = [];
      expect(() => parseManifestOrThrow(manifest)).toThrow(
        "Invalid Eliza-1 manifest: missing required files or RAM budget",
      );
    });

    it("rejects a manifest without a RAM budget", () => {
      const manifest = createValidManifest() as unknown as Record<
        string,
        unknown
      >;
      delete manifest.ramBudgetMb;
      expect(() => parseManifestOrThrow(manifest)).toThrow(
        "Invalid Eliza-1 manifest: missing required files or RAM budget",
      );
    });

    it("rejects a manifest without kernel verification data", () => {
      const manifest = createValidManifest() as unknown as Record<
        string,
        unknown
      >;
      delete manifest.kernels;
      expect(() => parseManifestOrThrow(manifest)).toThrow(
        "Invalid Eliza-1 manifest: missing kernel verification data",
      );
    });

    it("rejects a manifest without a tier", () => {
      const manifest = createValidManifest() as unknown as Record<
        string,
        unknown
      >;
      delete manifest.tier;
      expect(() => parseManifestOrThrow(manifest)).toThrow(
        "Invalid Eliza-1 manifest: missing kernel verification data",
      );
    });

    it("accepts a minimal manifest: only checked fields are required", () => {
      // Observed boundary: the parser validates id/version, non-empty text
      // files, ramBudgetMb presence, kernels.verifiedBackends presence, and
      // tier — nothing else. An empty verifiedBackends map and absent
      // optional file groups still parse, so downstream consumers own those
      // stricter checks.
      const parsed = parseManifestOrThrow({
        id: "eliza-1-min",
        version: "0.0.0",
        tier: "2b",
        ramBudgetMb: { min: 2048 },
        kernels: { verifiedBackends: {} },
        files: { text: [createFileEntry("models/text.gguf")] },
      });
      expect(parsed.id).toBe("eliza-1-min");
      expect(parsed.files.voice).toBeUndefined();
    });
  });
});
