import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadDocumentRuntime } from "./document-runtime.mjs";

test("document runtime rejects changed bytes or provenance before executing code", async () => {
  const dir = await mkdtemp(join(tmpdir(), "document-runtime-"));
  const file = join(dir, "runtime.mjs");
  const code = 'throw new Error("Module executed before verification");';
  const sourceCommit = "a".repeat(40),
    canvasVersion = "0.1.100";
  const provenance = {
    schemaVersion: 1,
    sourceCommit,
    canvasVersion,
    bundleSha256: createHash("sha256").update(code).digest("hex"),
  };
  try {
    await writeFile(file, code);
    await writeFile(
      `${file}.json`,
      JSON.stringify({ ...provenance, sourceCommit: "b".repeat(40) }),
    );
    await assert.rejects(
      loadDocumentRuntime(file, { sourceCommit, canvasVersion }),
      /provenance mismatch/,
    );
    await writeFile(`${file}.json`, JSON.stringify(provenance));
    await writeFile(file, code + "\n");
    await assert.rejects(
      loadDocumentRuntime(file, { sourceCommit, canvasVersion }),
      /provenance mismatch/,
    );
    await writeFile(file, code);
    await assert.rejects(
      loadDocumentRuntime(file, { sourceCommit, canvasVersion: "different" }),
      /provenance mismatch/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
