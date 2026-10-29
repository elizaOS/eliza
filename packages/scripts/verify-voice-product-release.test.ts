/**
 * Offline tests for the product voice release gate: the shipped catalog
 * passes, and each way a Phonon-2 / Paradee row can lose its pins fails.
 */

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  heldStatuses,
  validateProductVoiceRelease,
} from "./verify-voice-product-release.ts";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const catalogPath = path.join(
  root,
  "plugins/plugin-native-inference/src/model-catalog/voice-model-versions.json",
);
const inputsPath = path.join(
  root,
  "plugins/plugin-local-inference/native/android/inputs.json",
);
const noFork = path.join(root, "does-not-exist");

function catalog() {
  return JSON.parse(readFileSync(catalogPath, "utf8"));
}

function inputs() {
  return JSON.parse(readFileSync(inputsPath, "utf8"));
}

function rowOf(versions, id) {
  return versions[0].files.find((file) => file.id === id);
}

describe("verify-voice-product-release", () => {
  it("accepts the shipped catalog", () => {
    const result = validateProductVoiceRelease({ fork: noFork });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.rows.map(({ row }) => row.id).sort(), [
      "paradee-8m-v1.2",
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
    delete rowOf(versions, "paradee-8m-v1.2").source.files[1].bytes;
    const { errors } = validateProductVoiceRelease({ versions, fork: noFork });
    assert.ok(errors.some((error) => error.includes("positive size pin")));
  });

  it("rejects a GGUF hash that drifts from inputs.json", () => {
    const versions = catalog();
    rowOf(versions, "paradee-8m-v1.2").sha256 = "0".repeat(64);
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

  it("ships the Spanish voice on its recorded owner override", () => {
    const pins = inputs();
    assert.equal(pins.spanish.enabled, true);
    assert.deepEqual(pins.spanish.release_override, {
      model: "Delibes-8M-esES",
      decision: "Grace docs/decisions.md, owner decision 2026-10-28",
      overrides: ["human_approval PENDING", "commercial_distribution BLOCKED"],
    });
    assert.deepEqual(heldStatuses(pins.spanish.release_status), [
      "human_approval PENDING",
      "commercial_distribution BLOCKED",
    ]);
    const { errors } = validateProductVoiceRelease({
      inputs: pins,
      fork: noFork,
    });
    assert.deepEqual(errors, []);
  });

  it("rejects a bundled voice held PENDING or BLOCKED without an override", () => {
    const pins = inputs();
    delete pins.spanish.release_override;
    const { errors } = validateProductVoiceRelease({
      inputs: pins,
      fork: noFork,
    });
    assert.equal(errors.length, 2);
    assert.ok(
      errors.every(
        (error) =>
          error.includes("inputs.json spanish") &&
          error.includes("no release_override"),
      ),
    );
  });

  it("rejects an override that misses a held status or names another release", () => {
    const pins = inputs();
    pins.spanish.release_override.overrides = ["human_approval PENDING"];
    const missing = validateProductVoiceRelease({ inputs: pins, fork: noFork });
    assert.equal(missing.errors.length, 1);
    assert.match(
      missing.errors[0],
      /commercial_distribution BLOCKED.*does not override/,
    );
    const other = inputs();
    other.spanish.release_override.model = "Some-Other-Voice";
    assert.ok(
      validateProductVoiceRelease({ inputs: other, fork: noFork }).errors.some(
        (error) => error.includes("not the release in its source"),
      ),
    );
    const undecided = inputs();
    undecided.spanish.release_override.decision = " ";
    assert.ok(
      validateProductVoiceRelease({
        inputs: undecided,
        fork: noFork,
      }).errors.some((error) => error.includes("no decision reference")),
    );
  });

  it("checks the fork pins' release status against the override", () => {
    const fork = mkdtempSync(path.join(os.tmpdir(), "voice-release-fork-"));
    try {
      mkdirSync(path.join(fork, "tools/paradee"), { recursive: true });
      writeFileSync(
        path.join(fork, "tools/paradee/pins.json"),
        JSON.stringify({
          delibes: {
            model: {
              release_status:
                "human_approval PENDING and commercial_distribution BLOCKED",
            },
          },
        }),
      );
      const covered = inputs();
      covered.spanish.release_status = "Recorded in the fork pins.";
      assert.deepEqual(
        validateProductVoiceRelease({ inputs: covered, fork }).errors,
        [],
      );
      const bare = inputs();
      bare.spanish.release_status = "Recorded in the fork pins.";
      delete bare.spanish.release_override;
      const { errors } = validateProductVoiceRelease({ inputs: bare, fork });
      assert.equal(errors.length, 2);
      assert.ok(errors.every((error) => error.includes("the fork pins")));
    } finally {
      rmSync(fork, { recursive: true, force: true });
    }
  });

  it("keeps a disabled voice out of the catalog", () => {
    const versions = catalog();
    const pins = inputs();
    pins.spanish.enabled = false;
    delete pins.spanish.release_override;
    assert.deepEqual(
      validateProductVoiceRelease({ versions, inputs: pins, fork: noFork })
        .errors,
      [],
    );
    versions[0].files.push({
      ...rowOf(versions, "paradee-8m-v1.2"),
      id: "delibes-8m-eses",
      role: "tts-voice",
      path: pins.spanish.path,
    });
    const { errors } = validateProductVoiceRelease({
      versions,
      inputs: pins,
      fork: noFork,
    });
    assert.ok(errors.some((error) => error.includes("which is disabled")));
  });

  it("requires fork pins only when asked", () => {
    const { errors } = validateProductVoiceRelease({
      fork: noFork,
      requireForkPins: true,
    });
    assert.equal(errors.length, 2);
  });
});
