// Exercises tests turbo cache key.test automation behavior with deterministic script fixtures.
import { describe, expect, test } from "bun:test";

const cacheKey = await import(
  new URL("../turbo-cache-key.mjs", import.meta.url).href
);

const workspaceDirs = [
  "packages/core",
  "packages/prompts",
  "plugins/plugin-openai",
];

describe("turbo-cache-key input selection", () => {
  test("includes root build configuration and CI cache call sites", () => {
    expect(cacheKey.isTurboCacheInputFile("turbo.json", workspaceDirs)).toBe(
      true,
    );
    expect(
      cacheKey.isTurboCacheInputFile(
        ".github/actions/setup-bun-workspace/action.yml",
        workspaceDirs,
      ),
    ).toBe(true);
    expect(
      cacheKey.isTurboCacheInputFile(
        ".github/workflows/release.yaml",
        workspaceDirs,
      ),
    ).toBe(true);
  });

  test("includes package source, generated-spec inputs, and build configs", () => {
    expect(
      cacheKey.isTurboCacheInputFile(
        "packages/core/src/index.ts",
        workspaceDirs,
      ),
    ).toBe(true);
    expect(
      cacheKey.isTurboCacheInputFile(
        "packages/prompts/specs/actions/core.json",
        workspaceDirs,
      ),
    ).toBe(true);
    expect(
      cacheKey.isTurboCacheInputFile(
        "plugins/plugin-openai/vite.config.views.ts",
        workspaceDirs,
      ),
    ).toBe(true);
    expect(
      cacheKey.isTurboCacheInputFile(
        "plugins/plugin-openai/package.json",
        workspaceDirs,
      ),
    ).toBe(true);
  });

  test("does not include package docs or generated build outputs", () => {
    expect(
      cacheKey.isTurboCacheInputFile("packages/core/README.md", workspaceDirs),
    ).toBe(false);
    expect(
      cacheKey.isTurboCacheInputFile("plugins/plugin-openai/dist/index.js", [
        "plugins/plugin-openai",
      ]),
    ).toBe(false);
  });
});

describe("turbo-cache-key hashing", () => {
  test("hashes content deterministically regardless of record order", () => {
    const first = cacheKey.hashFileRecords([
      { relativePath: "b.ts", bytes: Buffer.from("two") },
      { relativePath: "a.ts", bytes: Buffer.from("one") },
    ]);
    const second = cacheKey.hashFileRecords([
      { relativePath: "a.ts", bytes: Buffer.from("one") },
      { relativePath: "b.ts", bytes: Buffer.from("two") },
    ]);

    expect(first).toBe(second);
  });

  test("changes when selected file contents change", () => {
    const before = cacheKey.hashFileRecords([
      { relativePath: "packages/core/src/index.ts", bytes: Buffer.from("one") },
    ]);
    const after = cacheKey.hashFileRecords([
      { relativePath: "packages/core/src/index.ts", bytes: Buffer.from("two") },
    ]);

    expect(after).not.toBe(before);
  });
});
