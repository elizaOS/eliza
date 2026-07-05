/**
 * Pure artifact-policy tests for conversation imports. The harness stays
 * in-memory so storage-key, retention, and content-addressing decisions remain
 * deterministic before any cloud object store integration exists.
 */
import { describe, expect, it } from "vitest";
import {
  buildImportArtifactDescriptor,
  DEFAULT_RAW_UPLOAD_RETENTION_MS,
  importArtifactByteLength,
  importArtifactExpired,
  sha256Hex,
} from "./artifacts.ts";

const scope = {
  tenantId: "tenant-a",
  appId: "app-main",
  batchId: "batch-2026-07-05",
  source: "chatgpt" as const,
};

describe("import artifact descriptors", () => {
  it("builds content-addressed tenant/app/batch storage keys", () => {
    const descriptor = buildImportArtifactDescriptor({
      kind: "derived-document",
      scope,
      contentType: "text/markdown",
      bytes: "# hello",
      extension: "md",
    });

    expect(descriptor.sha256).toBe(sha256Hex("# hello"));
    expect(descriptor.byteLength).toBe(Buffer.byteLength("# hello", "utf8"));
    expect(descriptor.storageKey).toBe(
      `conversation-imports/tenant-a/apps/app-main/batches/batch-2026-07-05/derived-document/${descriptor.sha256}.md`,
    );
    expect(descriptor.retention).toEqual({
      mode: "batch-lifecycle",
      deleteWithBatch: true,
    });
  });

  it("keeps the content address stable while scope changes the object key", () => {
    const first = buildImportArtifactDescriptor({
      kind: "derived-manifest",
      scope,
      contentType: "application/json",
      bytes: "{}",
      extension: "json",
    });
    const second = buildImportArtifactDescriptor({
      kind: "derived-manifest",
      scope: { ...scope, tenantId: "tenant-b" },
      contentType: "application/json",
      bytes: "{}",
      extension: "json",
    });

    expect(first.sha256).toBe(second.sha256);
    expect(first.storageKey).not.toBe(second.storageKey);
    expect(second.storageKey).toContain("/tenant-b/apps/app-main/");
  });

  it("applies short retention to raw uploads by default", () => {
    const now = Date.parse("2026-07-05T12:00:00Z");
    const descriptor = buildImportArtifactDescriptor({
      kind: "raw-upload",
      scope,
      contentType: "application/zip",
      bytes: new Uint8Array([1, 2, 3]),
      extension: "zip",
      now: () => now,
    });

    expect(descriptor.retention).toEqual({
      mode: "short-lived",
      retentionMs: DEFAULT_RAW_UPLOAD_RETENTION_MS,
      expiresAt: now + DEFAULT_RAW_UPLOAD_RETENTION_MS,
    });
    expect(importArtifactExpired(descriptor, now)).toBe(false);
    expect(
      importArtifactExpired(descriptor, now + DEFAULT_RAW_UPLOAD_RETENTION_MS),
    ).toBe(true);
  });

  it("requires an explicit reason before raw uploads can be retained longer", () => {
    expect(() =>
      buildImportArtifactDescriptor({
        kind: "raw-upload",
        scope,
        contentType: "application/json",
        bytes: "{}",
        rawRetention: { retainRawUpload: true },
      }),
    ).toThrow(/retainReason/);

    const descriptor = buildImportArtifactDescriptor({
      kind: "raw-upload",
      scope,
      contentType: "application/json",
      bytes: "{}",
      rawRetention: {
        retainRawUpload: true,
        retainReason: "user requested audit hold",
      },
    });

    expect(descriptor.retention).toEqual({
      mode: "explicit-raw-retain",
      reason: "user requested audit hold",
    });
  });

  it("honors caller-supplied short retention windows", () => {
    const descriptor = buildImportArtifactDescriptor({
      kind: "raw-upload",
      scope,
      contentType: "application/json",
      bytes: "{}",
      rawRetention: { retentionMs: 60_000 },
      now: () => 1000,
    });

    expect(descriptor.retention).toEqual({
      mode: "short-lived",
      retentionMs: 60_000,
      expiresAt: 61_000,
    });
  });

  it("rejects unsafe scope and extension components instead of escaping keys", () => {
    expect(() =>
      buildImportArtifactDescriptor({
        kind: "derived-document",
        scope: { ...scope, tenantId: "../tenant" },
        contentType: "text/markdown",
        bytes: "hi",
      }),
    ).toThrow(/tenantId/);
    expect(() =>
      buildImportArtifactDescriptor({
        kind: "derived-document",
        scope,
        contentType: "text/markdown",
        bytes: "hi",
        extension: "../md",
      }),
    ).toThrow(/extension/);
  });

  it("normalizes content type and UTF-8 byte length", () => {
    const descriptor = buildImportArtifactDescriptor({
      kind: "import-report",
      scope,
      contentType: " Application/JSON ",
      bytes: "é",
      extension: ".JSON",
    });

    expect(descriptor.contentType).toBe("application/json");
    expect(descriptor.byteLength).toBe(2);
    expect(importArtifactByteLength("é")).toBe(2);
    expect(descriptor.storageKey.endsWith(".json")).toBe(true);
  });
});
