import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadDocumentRuntime } from "./document-runtime.mjs";
import { NativeCloudServiceError } from "./errors.mjs";

test("document artifact admission requires explicit matching host provenance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eliza-document-admission-"));
  const file = join(dir, "runtime.mjs");
  const sourceCommit = "a".repeat(40);
  const canvasVersion = "0.1.0";
  const bytes = [
    "PdfService",
    "handleImageDescription",
    "resolveCloudSdkAuthorityTuple",
    "getNativeApplicationSlot",
    "getAppId",
  ]
    .map((key) => `export function ${key}() {}`)
    .join("\n");
  try {
    await writeFile(file, bytes);
    await writeFile(
      `${file}.json`,
      JSON.stringify({
        schemaVersion: 1,
        sourceCommit,
        canvasVersion,
        bundleSha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    );
    await assert.rejects(
      loadDocumentRuntime(file, { sourceCommit }),
      NativeCloudServiceError,
    );
    await assert.rejects(
      loadDocumentRuntime(file, {
        sourceCommit: "b".repeat(40),
        canvasVersion,
      }),
      NativeCloudServiceError,
    );
    await assert.rejects(
      loadDocumentRuntime(file, { sourceCommit, canvasVersion: "0.2.0" }),
      NativeCloudServiceError,
    );
    assert.equal(
      typeof (await loadDocumentRuntime(file, { sourceCommit, canvasVersion }))
        .PdfService,
      "function",
    );
    await writeFile(file, `${bytes}\n// changed after review`);
    await assert.rejects(
      loadDocumentRuntime(file, { sourceCommit, canvasVersion }),
      NativeCloudServiceError,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
