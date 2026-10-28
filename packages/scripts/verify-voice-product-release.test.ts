/**
 * Offline tests for the product voice release gate: the shipped catalog
 * passes, and each way a Phonon-2 / Paradee row can lose its pins fails.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { validateProductVoiceRelease } from "./verify-voice-product-release.ts";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const catalogPath = path.join(
  root,
  "plugins/plugin-native-inference/src/model-catalog/voice-model-versions.json",
);
const noFork = path.join(root, "does-not-exist");

function catalog() {
  return JSON.parse(readFileSync(catalogPath, "utf8"));
}

function rowOf(versions, id) {
  return versions[0].files.find((file) => file.id === id);
}

describe("verify-voice-product-release", () => {
  it("accepts the shipped catalog", () => {
    const result = validateProductVoiceRelease({ fork: noFork });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.rows.map(({ row }) => row.id).sort(), [
      "paradee-8m-v1.1",
      "phonon-2-fv5",
    ]);
  });

  it("declares no standalone or Gemma ASR release", () => {
    const versions = catalog();
    assert.equal(
      versions.some((version) => version.id === "asr"),
      false,
    );
    assert.doesNotMatch(JSON.stringify(versions), /gemma-asr/i);
  });

  it("rejects a mutable source revision", () => {
    const versions = catalog();
    rowOf(versions, "phonon-2-fv5").source.revision = "main";
    const { errors } = validateProductVoiceRelease({ versions, fork: noFork });
    assert.ok(errors.some((error) => error.includes("40-character")));
  });

  it("rejects a source file without a size pin", () => {
    const versions = catalog();
    delete rowOf(versions, "paradee-8m-v1.1").source.files[1].bytes;
    const { errors } = validateProductVoiceRelease({ versions, fork: noFork });
    assert.ok(errors.some((error) => error.includes("positive size pin")));
  });

  it("rejects a GGUF hash that drifts from inputs.json", () => {
    const versions = catalog();
    rowOf(versions, "paradee-8m-v1.1").sha256 = "0".repeat(64);
    const { errors } = validateProductVoiceRelease({ versions, fork: noFork });
    assert.ok(errors.some((error) => error.includes("inputs.json")));
  });

  it("rejects a source repository other than the one inputs.json pins", () => {
    const versions = catalog();
    rowOf(versions, "phonon-2-fv5").source.repo = "elizaos/eliza-1";
    const { errors } = validateProductVoiceRelease({ versions, fork: noFork });
    assert.ok(errors.some((error) => error.includes("not the repository")));
  });

  it("rejects a second ASR model", () => {
    const versions = catalog();
    versions[0].files.push({
      ...rowOf(versions, "phonon-2-fv5"),
      id: "eliza-1-gemma-asr",
      role: "asr-text",
    });
    const { errors } = validateProductVoiceRelease({ versions, fork: noFork });
    assert.ok(errors.some((error) => error.includes("only product ASR")));
    assert.ok(errors.some((error) => error.includes("retired voice model")));
  });

  it("requires fork pins only when asked", () => {
    const { errors } = validateProductVoiceRelease({
      fork: noFork,
      requireForkPins: true,
    });
    assert.equal(errors.length, 2);
  });
});
