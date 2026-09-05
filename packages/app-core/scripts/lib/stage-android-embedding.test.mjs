/** Exercises Android model packaging against real files, including corrupt-source rejection. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stageAndroidEmbedding } from "./stage-android-embedding.mjs";

test("packages verified bytes and rejects a corrupt refresh without replacing the packaged model", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "android-embedding-stage-"));
  const source = path.join(root, "source.gguf");
  const bytes = Buffer.from("GGUF deterministic packaging fixture");
  const artifact = {
    filename: "embedding.gguf",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const ensureEmbedding = async () => ({ path: source });
  try {
    writeFileSync(source, bytes);
    const staged = await stageAndroidEmbedding(path.join(root, "assets"), {
      artifact,
      ensureEmbedding,
    });
    assert.deepEqual(readFileSync(staged.modelPath), bytes);
    const manifest = JSON.parse(readFileSync(staged.manifestPath, "utf8"));
    assert.equal(
      createHash("sha256").update(readFileSync(staged.modelPath)).digest("hex"),
      manifest.sha256,
    );
    writeFileSync(staged.modelPath, Buffer.alloc(bytes.length, 2));
    writeFileSync(staged.manifestPath, "incomplete metadata");
    const repaired = await stageAndroidEmbedding(path.join(root, "assets"), {
      artifact,
      ensureEmbedding,
    });
    assert.deepEqual(readFileSync(repaired.modelPath), bytes);
    assert.equal(
      JSON.parse(readFileSync(repaired.manifestPath, "utf8")).sha256,
      artifact.sha256,
    );
    const reused = await stageAndroidEmbedding(path.join(root, "assets"), {
      artifact,
      ensureEmbedding,
    });
    assert.equal(reused.changed, 0);
    writeFileSync(source, Buffer.alloc(bytes.length, 1));
    await assert.rejects(
      stageAndroidEmbedding(path.join(root, "assets"), {
        artifact,
        ensureEmbedding,
      }),
      /verification/,
    );
    assert.deepEqual(readFileSync(staged.modelPath), bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
