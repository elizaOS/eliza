/**
 * Verifies the derived bionic bundle view against real filesystem entries,
 * including stale equal-sized files and broken aliases.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveBionicBundleDir } from "./bionic-bundle-view";

const temporaryRoots: string[] = [];

function temporaryModelsDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "eliza-bionic-view-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("deriveBionicBundleDir", () => {
  it("replaces an equal-sized stale model instead of trusting byte length", () => {
    const models = temporaryModelsDir();
    const model = path.join(models, "eliza-1-e2b-128k.gguf");
    writeFileSync(model, "new1");
    const bundle = deriveBionicBundleDir(model);
    const staged = path.join(bundle, "text", path.basename(model));

    unlinkSync(staged);
    writeFileSync(staged, "old1");
    deriveBionicBundleDir(model);

    expect(readFileSync(staged, "utf8")).toBe("new1");
  });

  it("repairs broken model and auxiliary directory symlinks", () => {
    const models = temporaryModelsDir();
    const model = path.join(models, "eliza-1-e4b-128k.gguf");
    const asr = path.join(models, "asr");
    mkdirSync(asr);
    writeFileSync(path.join(asr, "model.gguf"), "asr");
    writeFileSync(model, "weights");
    const bundle = deriveBionicBundleDir(model);
    const stagedModel = path.join(bundle, "text", path.basename(model));
    const stagedAsr = path.join(bundle, "asr");

    unlinkSync(stagedModel);
    symlinkSync(path.join(models, "missing.gguf"), stagedModel);
    rmSync(stagedAsr, { recursive: true, force: true });
    symlinkSync(path.join(models, "missing-asr"), stagedAsr);
    deriveBionicBundleDir(model);

    expect(readFileSync(stagedModel, "utf8")).toBe("weights");
    expect(readFileSync(path.join(stagedAsr, "model.gguf"), "utf8")).toBe(
      "asr",
    );
  });
});
