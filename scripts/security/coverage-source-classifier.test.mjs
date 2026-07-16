/**
 * Verifies runtime-source classification in Bun, including TypeScript erasure,
 * comment-directive anchoring, and conservative failures. Bun does not expose
 * node:module.stripTypeScriptTypes, so this suite exercises the classifier's
 * runtime fallback that Node-only unit runs never reach.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyPaths,
  pathRetainsRuntimeCode,
  sourceChangesRuntimeCode,
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

// Under Bun the comment-preserving type stripper falls back to the raw source
// (node:module.stripTypeScriptTypes is Node-only), so these cases are the ONLY
// place the fallback anchor path is exercised. They pin the guarantee the gate
// depends on: a change with identical emitted JavaScript is dropped, while a
// comment directive that survives into the bundle or steers coverage is kept.
describe("comment-anchored runtime-equivalence under the Bun fallback", () => {
  test("drops a change whose emitted JavaScript is unchanged", () => {
    expect(
      sourceChangesRuntimeCode(
        "export const value: number = 1;\n",
        "export   const value : number | string = 1;\n",
      ),
    ).toBe(false);
  });

  test("keeps a bundling directive that only appears in a comment", () => {
    expect(
      sourceChangesRuntimeCode(
        'export const load = () => import("./module");\n',
        'export const load = () => import(/* @vite-ignore */ "./module");\n',
      ),
    ).toBe(true);
  });

  test("keeps an added coverage-steering directive", () => {
    expect(
      sourceChangesRuntimeCode(
        "export const value: number = 1;\n",
        "/* c8 ignore next */\nexport const value: number = 1;\n",
      ),
    ).toBe(true);
  });

  test("excludes the runtime-equivalent path while retaining the real change", () => {
    const directory = mkdtempSync(join(tmpdir(), "coverage-source-fallback-"));
    const equivalentPath = join(directory, "equivalent.ts");
    const changedPath = join(directory, "changed.ts");
    const baseSources = new Map([
      [equivalentPath, "export const value: number = 1;\n"],
      [changedPath, "export const value: number = 1;\n"],
    ]);
    try {
      writeFileSync(
        equivalentPath,
        "export   const value : string | number = 1;\n",
      );
      writeFileSync(changedPath, "export const value: number = 2;\n");

      let output = "";
      let errors = "";
      classifyPaths(
        [equivalentPath, changedPath],
        (message) => {
          output += message;
        },
        (message) => {
          errors += message;
        },
        { readBaseSource: (path) => baseSources.get(path) },
      );

      expect(output).toBe(`${changedPath}\n`);
      expect(errors).toContain(
        `excluding runtime-equivalent source change: ${equivalentPath}`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
