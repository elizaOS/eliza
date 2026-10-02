import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { validateExtensionModules } from "./validate-extension-modules.mjs";

test("staged worker validation catches missing transitive modules without executing code", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "eliza-extension-stage-"),
  );
  try {
    await writeFile(
      path.join(directory, "background.mjs"),
      'import { handler } from "./command-handler.mjs"; handler(); throw new Error("must not execute");',
    );
    await writeFile(
      path.join(directory, "command-handler.mjs"),
      'export { handler } from "./manual-activity.mjs";',
    );
    await assert.rejects(
      validateExtensionModules(directory),
      /manual-activity\.mjs/,
    );
    await writeFile(
      path.join(directory, "manual-activity.mjs"),
      'export function handler() { throw new Error("must not execute"); }',
    );
    await validateExtensionModules(directory);
    await writeFile(
      path.join(directory, "manual-activity.mjs"),
      "export function handler( {",
    );
    await assert.rejects(
      validateExtensionModules(directory),
      /module graph is invalid/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
