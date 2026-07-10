/** Verifies source-aware runtime classification and fail-wide parse handling. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  classifyPaths,
  pathRetainsRuntimeCode,
  sourceRetainsRuntimeCode,
} from "../../../scripts/security/coverage-source-classifier.mjs";

describe("changed-source runtime classifier", () => {
  test("excludes syntax erased by the TypeScript transform", () => {
    expect(
      sourceRetainsRuntimeCode("export interface Foo { id: string }\n"),
    ).toBe(false);
    expect(
      sourceRetainsRuntimeCode("export type Foo = { id: string };\n"),
    ).toBe(false);
    expect(
      sourceRetainsRuntimeCode(
        'import type { Foo } from "./foo"; export type { Foo };\n',
      ),
    ).toBe(false);
    expect(
      sourceRetainsRuntimeCode("export declare const foo: string;\n"),
    ).toBe(false);
    expect(
      sourceRetainsRuntimeCode("// comments contain no runtime code\n"),
    ).toBe(false);
  });

  test("retains runtime declarations and side-effect imports", () => {
    expect(sourceRetainsRuntimeCode('export const foo: string = "x";\n')).toBe(
      true,
    );
    expect(
      sourceRetainsRuntimeCode(
        'import "./side-effect"; export interface Foo {}\n',
      ),
    ).toBe(true);
    expect(sourceRetainsRuntimeCode("exports.value = 1;\n")).toBe(true);
  });

  test("treats an unparseable module as executable", () => {
    const dir = mkdtempSync(join(tmpdir(), "coverage-source-classifier-"));
    const path = join(dir, "runtime.tsx");
    const warnings: string[] = [];
    try {
      writeFileSync(path, "export const View = () => <div />;\n");
      expect(
        pathRetainsRuntimeCode(path, (message) => warnings.push(message)),
      ).toBe(true);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(
        "treating unclassifiable module as executable",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("emits runtime paths and explains type-only exclusions", () => {
    const dir = mkdtempSync(join(tmpdir(), "coverage-source-list-"));
    const runtimePath = join(dir, "runtime.mts");
    const typesPath = join(dir, "types.ts");
    const output: string[] = [];
    const diagnostics: string[] = [];
    try {
      writeFileSync(runtimePath, "export const value: number = 1;\n");
      writeFileSync(typesPath, "export interface Value { id: string }\n");
      classifyPaths(
        [runtimePath, typesPath],
        (message) => output.push(message),
        (message) => diagnostics.push(message),
      );
      expect(output).toEqual([`${runtimePath}\n`]);
      expect(diagnostics).toEqual([
        `[coverage-source-classifier] excluding type-only module: ${typesPath}\n`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
