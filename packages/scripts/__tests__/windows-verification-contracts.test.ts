/**
 * Cross-platform verification contracts for source discovery, generated i18n
 * execution, and native-package lint orchestration.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  isDirectRun,
  runKeywordGenerator,
} from "../../app-core/scripts/ensure-shared-i18n-data.mjs";
import { discoverTypeScriptFiles } from "../run-biome-typescript.mjs";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "windows-contracts "));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("shared i18n direct execution", () => {
  test("matches encoded file URLs through Node path conversion", () => {
    const entry = path.join(tempRoot(), "nested space", "generate.mjs");
    expect(pathToFileURL(entry).href).toContain("%20");
    expect(isDirectRun(pathToFileURL(entry).href, entry)).toBe(true);
    expect(isDirectRun(pathToFileURL(`${entry}.other`).href, entry)).toBe(
      false,
    );
  });

  test("runs the configured generator as a real child process", () => {
    const root = tempRoot();
    const marker = path.join(root, "generated.txt");
    const generator = path.join(root, "generator.mjs");
    fs.writeFileSync(
      generator,
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "generated");\n`,
    );

    expect(
      runKeywordGenerator({ generatorPath: generator, cwd: root }),
    ).toEqual({ skipped: false });
    expect(fs.readFileSync(marker, "utf8")).toBe("generated");
  });
});

describe("TypeScript-only Biome discovery", () => {
  test("is recursive, deterministic, and excludes declarations and fixtures", () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, "nested"), { recursive: true });
    fs.writeFileSync(path.join(root, "z.ts"), "");
    fs.writeFileSync(path.join(root, "nested", "a.ts"), "");
    fs.writeFileSync(path.join(root, "types.d.ts"), "");
    fs.writeFileSync(path.join(root, "component.tsx"), "");
    fs.writeFileSync(path.join(root, "fixture.json"), "{}");

    expect(
      discoverTypeScriptFiles(root).map((file) => path.relative(root, file)),
    ).toEqual([path.join("nested", "a.ts"), "z.ts"]);
  });

  test("logger uses the shared shell-free runner", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    const packageJson = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "packages/logger/package.json"),
        "utf8",
      ),
    ) as { scripts: Record<string, string> };
    for (const script of ["lint:check", "format"]) {
      expect(packageJson.scripts[script]).toContain("run-biome-typescript.mjs");
      expect(packageJson.scripts[script]).not.toMatch(/find|xargs/);
    }
  });
});

test("native Gateway lint always delegates SwiftLint to its package wrapper", () => {
  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  const packageJson = JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, "plugins/plugin-native-gateway/package.json"),
      "utf8",
    ),
  ) as { scripts: Record<string, string> };
  for (const script of ["lint", "lint:check", "fmt"]) {
    expect(packageJson.scripts[script]).toContain("bun run swiftlint -- lint");
    expect(packageJson.scripts[script]).not.toMatch(/\bbash\b|command -v/);
  }
  expect(packageJson.scripts.swiftlint).toBe("node-swiftlint");
});
