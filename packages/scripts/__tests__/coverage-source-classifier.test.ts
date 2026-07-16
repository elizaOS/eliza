/** Verifies source-aware runtime classification and fail-wide parse handling. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  classifyPaths,
  pathRetainsRuntimeCode,
  sourceChangesRuntimeCode,
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

  test("excludes changes with equivalent emitted JavaScript", () => {
    const base = "export const value: number = 1;\n";
    const head = "export   const value : number | string = 1;\n";
    expect(sourceChangesRuntimeCode(base, head)).toBe(false);
  });

  test("retains comment directives that affect bundling or coverage", () => {
    const base = 'export const load = () => import("./module");\n';
    expect(
      sourceChangesRuntimeCode(
        base,
        'export const load = () => import(/* @vite-ignore */ "./module");\n',
      ),
    ).toBe(true);
    expect(
      sourceChangesRuntimeCode(
        "export const value: number = 1;\n",
        "/* c8 ignore next */\nexport const value: number = 1;\n",
      ),
    ).toBe(true);
  });

  test("retains type changes that can alter decorator metadata", () => {
    expect(
      sourceChangesRuntimeCode(
        "class Example { @field value: string; }\n",
        "class Example { @field value: number; }\n",
      ),
    ).toBe(true);
  });

  test("retains runtime changes and conservative import reordering", () => {
    expect(
      sourceChangesRuntimeCode(
        "export const value: number = 1;\n",
        "export const value: number = 2;\n",
      ),
    ).toBe(true);
    expect(
      sourceChangesRuntimeCode(
        'import "./a";\nimport "./b";\n',
        'import "./b";\nimport "./a";\n',
      ),
    ).toBe(true);
  });

  test("excludes pure re-export facades but retains local runtime exports", () => {
    expect(sourceRetainsRuntimeCode('export * from "./button";\n')).toBe(false);
    expect(
      sourceRetainsRuntimeCode(
        'export { Message, MessageContent as Content } from "./message";\n',
      ),
    ).toBe(false);
    expect(
      sourceRetainsRuntimeCode(
        'export * from "./button";\nexport const version = 1;\n',
      ),
    ).toBe(true);
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
        `[coverage-source-classifier] excluding module without coverable runtime statements: ${typesPath}\n`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("excludes only proven runtime-equivalent source changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "coverage-source-delta-"));
    const equivalentPath = join(dir, "equivalent.ts");
    const changedPath = join(dir, "changed.ts");
    const addedPath = join(dir, "added.ts");
    const output: string[] = [];
    const diagnostics: string[] = [];
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
      writeFileSync(addedPath, "export const added = true;\n");
      classifyPaths(
        [equivalentPath, changedPath, addedPath],
        (message) => output.push(message),
        (message) => diagnostics.push(message),
        { readBaseSource: (path) => baseSources.get(path) },
      );
      expect(output).toEqual([`${changedPath}\n`, `${addedPath}\n`]);
      expect(diagnostics).toEqual([
        `[coverage-source-classifier] excluding runtime-equivalent source change: ${equivalentPath}\n`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("retains a source change when base comparison fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "coverage-source-fail-wide-"));
    const path = join(dir, "runtime.ts");
    const output: string[] = [];
    const diagnostics: string[] = [];
    try {
      writeFileSync(path, "export const value = 1;\n");
      classifyPaths(
        [path],
        (message) => output.push(message),
        (message) => diagnostics.push(message),
        { readBaseSource: () => "export const broken = <;\n" },
      );
      expect(output).toEqual([`${path}\n`]);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toContain(
        "treating unclassifiable source change as executable",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
