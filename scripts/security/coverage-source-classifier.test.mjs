/** Verifies runtime-source classification in Bun, including TypeScript erasure and conservative failures. */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyPaths,
  pathRetainsRuntimeCode,
  sourceRetainsRuntimeCode,
} from "./coverage-source-classifier.mjs";

describe("coverage source classifier", () => {
  test("erases TypeScript-only declarations but retains executable modules", () => {
    expect(
      sourceRetainsRuntimeCode("export interface Record { id: string }\n"),
    ).toBe(false);
    expect(
      sourceRetainsRuntimeCode("export type Identifier = string;\n"),
    ).toBe(false);
    expect(
      sourceRetainsRuntimeCode("export const value: number = 1;\n"),
    ).toBe(true);
  });

  test("excludes pure re-export facades", () => {
    expect(sourceRetainsRuntimeCode('export * from "./runtime.js";\n')).toBe(false);
    expect(sourceRetainsRuntimeCode('export { value } from "./runtime.js";\n')).toBe(false);
  });

  test("classifies paths and reports exclusions", () => {
    const directory = mkdtempSync(join(tmpdir(), "coverage-source-classifier-"));
    const runtimePath = join(directory, "runtime.ts");
    const typesPath = join(directory, "types.ts");
    writeFileSync(runtimePath, "export const value: number = 1;\n");
    writeFileSync(typesPath, "export interface Record { id: string }\n");

    try {
      let output = "";
      let errors = "";
      classifyPaths(
        [runtimePath, typesPath],
        (message) => {
          output += message;
        },
        (message) => {
          errors += message;
        },
      );

      expect(output).toBe(`${runtimePath}\n`);
      expect(errors).toContain(typesPath);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("retains unreadable paths so classifier failures cannot weaken enforcement", () => {
    const warnings = [];
    expect(
      pathRetainsRuntimeCode("/definitely/missing.ts", (message) =>
        warnings.push(message),
      ),
    ).toBe(true);
    expect(warnings.join("")).toContain(
      "treating unclassifiable module as executable",
    );
  });
});
