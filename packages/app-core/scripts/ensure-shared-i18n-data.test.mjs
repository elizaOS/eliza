/** Verifies the dev-start i18n generation gate against real temporary files. */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { keywordGenerationNeeded } from "./ensure-shared-i18n-data.mjs";

const temporaryDirectories = [];

function createFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "eliza-i18n-gate-"));
  temporaryDirectories.push(root);
  const keywordsDir = path.join(root, "keywords");
  mkdirSync(keywordsDir);
  const generatorPath = path.join(root, "generate.mjs");
  const inputPath = path.join(keywordsDir, "shared.keywords.json");
  const generatedPaths = ["shared.ts", "shared.js", "core.ts"].map((name) =>
    path.join(root, name),
  );
  for (const filePath of [generatorPath, inputPath, ...generatedPaths]) {
    writeFileSync(filePath, "fixture");
  }
  return { generatedPaths, generatorPath, inputPath, keywordsDir };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("keywordGenerationNeeded", () => {
  it("skips generation when every output is newer than the inputs", () => {
    const fixture = createFixture();
    const oldTime = new Date(Date.now() - 10_000);
    const newTime = new Date();
    utimesSync(fixture.generatorPath, oldTime, oldTime);
    utimesSync(fixture.inputPath, oldTime, oldTime);
    for (const outputPath of fixture.generatedPaths) {
      utimesSync(outputPath, newTime, newTime);
    }

    expect(keywordGenerationNeeded(fixture)).toBe(false);
  });

  it("regenerates when an input is newer than the oldest output", () => {
    const fixture = createFixture();
    const oldTime = new Date(Date.now() - 10_000);
    const newTime = new Date();
    for (const outputPath of fixture.generatedPaths) {
      utimesSync(outputPath, oldTime, oldTime);
    }
    utimesSync(fixture.inputPath, newTime, newTime);

    expect(keywordGenerationNeeded(fixture)).toBe(true);
  });

  it("regenerates when any required output is missing", () => {
    const fixture = createFixture();
    rmSync(fixture.generatedPaths[1]);

    expect(keywordGenerationNeeded(fixture)).toBe(true);
  });
});
