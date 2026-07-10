#!/usr/bin/env node
/** Emits changed modules that retain runtime code after Node strips TypeScript-only syntax. */

import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const paths = readFileSync(0, "utf8").split("\n").filter(Boolean);

for (const path of paths) {
  try {
    const source = readFileSync(path, "utf8");
    const runtimeSource = stripTypeScriptTypes(source, {
      mode: "transform",
      sourceMap: false,
    });
    if (runtimeSource.trim().length > 0) {
      process.stdout.write(`${path}\n`);
    } else {
      process.stderr.write(
        `[coverage-source-classifier] excluding type-only module: ${path}\n`,
      );
    }
  } catch (error) {
    // A classifier failure must widen enforcement, never hide the source.
    process.stderr.write(
      `[coverage-source-classifier] treating unclassifiable module as executable: ${path} (${error instanceof Error ? error.message : String(error)})\n`,
    );
    process.stdout.write(`${path}\n`);
  }
}
