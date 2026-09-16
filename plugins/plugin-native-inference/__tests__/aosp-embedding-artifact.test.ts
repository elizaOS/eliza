/** Exercises the real filesystem admission boundary against renamed and partial encoder files. */

import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareAospEmbeddingBundle } from "../src/aosp-embedding-artifact.js";

describe("AOSP embedding artifact admission", () => {
  it.each(["GGUF chat weights", "partial encoder download", ""])(
    "rejects invalid bytes before staging a native bundle: %s",
    (bytes) => {
      const root = mkdtempSync(path.join(os.tmpdir(), "aosp-bge-admission-"));
      const model = path.join(root, "bge-small-en-v1.5-f16.gguf");
      try {
        writeFileSync(model, bytes);
        expect(() => prepareAospEmbeddingBundle(model)).toThrow(
          expect.objectContaining({ code: "EMBEDDING_ARTIFACT_INVALID" }),
        );
        expect(existsSync(`${model}.embedding.bundle`)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
