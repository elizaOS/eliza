import { describe, expect, test } from "bun:test";

import {
  auditTrackedRepository,
  auditTypeScriptToolchain,
  LEGACY_API_SPEC,
  TYPESCRIPT_VERSION,
} from "../audit-typescript-toolchain.mjs";

function pkg(
  file: string,
  value: Record<string, unknown>,
): { path: string; text: string } {
  return { path: file, text: JSON.stringify(value) };
}

function source(path: string, text: string) {
  return { path, text };
}

const directTypeScriptImport = [
  "import ts from ",
  '"',
  "typescript",
  '";',
].join("");
const legacyApiImport = [
  "import ts from ",
  '"',
  "@typescript/legacy-api",
  '";',
].join("");
const doubleQuote = String.fromCharCode(34);
const hardcodedCompilerPath = [
  "const compiler = ",
  doubleQuote,
  "node_modules/type",
  "script/bin/tsc",
  doubleQuote,
  ";",
].join("");
const hardcodedCompilerCommand = [
  "node node_modules/type",
  "script/lib/tsc.js -p tsconfig.json",
].join("");

describe("TypeScript toolchain audit", () => {
  test("covers nested tracked packages outside workspace globs", () => {
    const result = auditTypeScriptToolchain([
      pkg("package.json", {
        devDependencies: { typescript: TYPESCRIPT_VERSION },
        scripts: { typecheck: "tsc --noEmit" },
      }),
      pkg("independent/examples/deep/package.json", {
        devDependencies: { typescript: TYPESCRIPT_VERSION },
      }),
    ]);

    expect(result.violations).toEqual([]);
    expect(result.stats.packageJsonFiles).toBe(2);
  });

  test("requires every direct TypeScript dependency to use the exact version", () => {
    const result = auditTypeScriptToolchain([
      pkg("packages/bad/package.json", {
        devDependencies: { typescript: "^7.0.2" },
      }),
    ]);

    expect(result.violations.map((v) => v.message)).toContain(
      'devDependencies.typescript must be exactly 7.0.2, found "^7.0.2"',
    );
  });

  test("rejects native-preview, executable tsgo, and private compiler paths", () => {
    const result = auditTypeScriptToolchain([
      pkg("packages/bad/package.json", {
        devDependencies: { "@typescript/native-preview": "latest" },
        scripts: {
          typecheck: "tsgo --noEmit",
          build: hardcodedCompilerCommand,
          classify: "node classify.mjs tsgo",
        },
      }),
      source("packages/bad/scripts/compiler.ts", hardcodedCompilerPath),
    ]);
    const messages = result.violations.map((v) => v.message);

    expect(messages.some((message) => message.includes("native-preview"))).toBe(
      true,
    );
    expect(messages.some((message) => message.includes("removed tsgo"))).toBe(
      true,
    );
    expect(
      messages.filter((message) => message.includes("removed tsgo")),
    ).toHaveLength(1);
    expect(messages.some((message) => message.includes("compiler path"))).toBe(
      true,
    );
  });

  test("rejects direct compiler API imports", () => {
    const result = auditTypeScriptToolchain([
      source("packages/bad/src/compiler.ts", directTypeScriptImport),
    ]);

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].message).toContain(
      "compiler-API consumers must use @typescript/legacy-api",
    );
  });

  test("allows the compatibility alias only for reviewed consumers", () => {
    const approved = auditTypeScriptToolchain([
      pkg("package.json", {
        devDependencies: {
          typescript: TYPESCRIPT_VERSION,
          "@typescript/legacy-api": LEGACY_API_SPEC,
        },
      }),
      source("scripts/assert-comment-only-diff.mjs", legacyApiImport),
    ]);
    expect(approved.violations).toEqual([]);

    const unapproved = auditTypeScriptToolchain([
      pkg("packages/new/package.json", {
        devDependencies: { "@typescript/legacy-api": LEGACY_API_SPEC },
      }),
      source("packages/new/src/compiler.ts", legacyApiImport),
    ]);
    expect(
      unapproved.violations.some((v) =>
        v.message.includes("not an approved compiler-API consumer"),
      ),
    ).toBe(true);
    expect(
      unapproved.violations.some((v) =>
        v.message.includes("not an approved compatibility owner"),
      ),
    ).toBe(true);
  });

  test("the live tracked repository satisfies the contract", () => {
    expect(auditTrackedRepository().violations).toEqual([]);
  });

  test("is part of the root verification path", async () => {
    const manifest = await Bun.file(
      new URL("../../../package.json", import.meta.url),
    ).json();

    expect(manifest.scripts["audit:typescript-toolchain"]).toContain(
      "audit-typescript-toolchain.mjs",
    );
    expect(manifest.scripts.verify).toContain(
      "bun run audit:typescript-toolchain",
    );
  });
});
