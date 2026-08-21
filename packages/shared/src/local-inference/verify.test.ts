/**
 * Tests for model-file integrity verification and SHA-256 hashing.
 */
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InstalledModel } from "./types.ts";
import {
  __registryPathForTests,
  hashFile,
  verifyInstalledModel,
} from "./verify.ts";

describe("verifyInstalledModel", () => {
  let tempDir: string;
  let validGgufPath: string;
  let validGgufSha256: string;
  let nonGgufPath: string;

  beforeAll(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "eliza-verify-test-"));

    // Create a mock GGUF file
    validGgufPath = path.join(tempDir, "model.gguf");
    const ggufData = Buffer.concat([
      Buffer.from("GGUF", "ascii"),
      Buffer.from("extra model weights and metadata bytes"),
    ]);
    await fsp.writeFile(validGgufPath, ggufData);
    validGgufSha256 = createHash("sha256").update(ggufData).digest("hex");

    // Create a non-GGUF truncated file
    nonGgufPath = path.join(tempDir, "plain.txt");
    await fsp.writeFile(nonGgufPath, Buffer.from("NOT_GGUF_HEADER_BYTES"));
  });

  afterAll(async () => {
    try {
      await fsp.rm(tempDir, { recursive: true, force: true });
    } catch {
      // error-policy:J6 temporary test-directory cleanup is best-effort.
    }
  });

  it("returns missing state when file path does not exist on disk", async () => {
    const model: InstalledModel = {
      id: "missing-model",
      source: "eliza-download",
      lastUsedAt: null,
      path: path.join(tempDir, "non-existent.gguf"),
      sha256: "some-hash",
      displayName: "Mock Model",
      sizeBytes: 1000,
      installedAt: new Date().toISOString(),
    };

    const result = await verifyInstalledModel(model);
    expect(result.state).toBe("missing");
    expect(result.currentSha256).toBeNull();
    expect(result.expectedSha256).toBe("some-hash");
  });

  it("returns truncated state when header is not valid GGUF", async () => {
    const model: InstalledModel = {
      id: "corrupted-model",
      displayName: "Corrupted Model",
      source: "eliza-download",
      lastUsedAt: null,
      path: nonGgufPath,
      sha256: "some-hash",
      sizeBytes: 21,
      installedAt: new Date().toISOString(),
    };

    const result = await verifyInstalledModel(model);
    expect(result.state).toBe("truncated");
    expect(result.currentSha256).toBeNull();
    expect(result.currentBytes).toBe(21);
  });

  it("returns unknown state when valid GGUF model has no baseline hash in registry", async () => {
    const model: InstalledModel = {
      id: "fresh-model",
      displayName: "Fresh Model",
      source: "eliza-download",
      lastUsedAt: null,
      path: validGgufPath,
      sizeBytes: 41,
      installedAt: new Date().toISOString(),
    };

    const result = await verifyInstalledModel(model);
    expect(result.state).toBe("unknown");
    expect(result.currentSha256).toBe(validGgufSha256);
    expect(result.expectedSha256).toBeNull();
  });

  it("returns ok state when computed hash matches expected hash", async () => {
    const model: InstalledModel = {
      id: "verified-model",
      displayName: "Verified Model",
      source: "eliza-download",
      lastUsedAt: null,
      path: validGgufPath,
      sha256: validGgufSha256,
      sizeBytes: 41,
      installedAt: new Date().toISOString(),
    };

    const result = await verifyInstalledModel(model);
    expect(result.state).toBe("ok");
    expect(result.currentSha256).toBe(validGgufSha256);
    expect(result.expectedSha256).toBe(validGgufSha256);
  });

  it("returns mismatch state when computed hash differs from expected hash", async () => {
    const model: InstalledModel = {
      id: "tampered-model",
      displayName: "Tampered Model",
      source: "eliza-download",
      lastUsedAt: null,
      path: validGgufPath,
      sha256:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      sizeBytes: 41,
      installedAt: new Date().toISOString(),
    };

    const result = await verifyInstalledModel(model);
    expect(result.state).toBe("mismatch");
    expect(result.currentSha256).toBe(validGgufSha256);
    expect(result.expectedSha256).toBe(
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
  });

  it("computes exact hash via hashFile", async () => {
    const hash = await hashFile(validGgufPath);
    expect(hash).toBe(validGgufSha256);
  });

  it("exposes registry path for tests", () => {
    expect(__registryPathForTests()).toMatch(/registry\.json$/);
  });
});
