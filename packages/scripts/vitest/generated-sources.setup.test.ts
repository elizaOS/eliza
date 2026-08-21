/**
 * Verifies the generated-source Vitest global setup against the real generator,
 * driven inside a throwaway checkout so this repository's own generated output
 * and any concurrent lane are never disturbed, plus the package lane that wires
 * the setup.
 */
import { existsSync, rmSync } from "node:fs";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import setup, {
  CORE_GENERATED_KEYWORD_DATA_RELATIVE_PATH,
  coreGeneratedKeywordDataPath,
  keywordGeneratorPath,
  materializeGeneratedSources,
} from "./generated-sources.setup.ts";
import { repoRoot } from "./repo-root.ts";

const tempRoots: string[] = [];

/**
 * Copy only the generator and its JSON keyword inputs into a temp root, which
 * is enough for `generate-keywords.mjs` to produce both outputs it owns.
 */
async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "generated-sources-setup-"));
  tempRoots.push(root);
  await cp(
    path.join(repoRoot, "packages/shared/scripts"),
    path.join(root, "packages/shared/scripts"),
    { recursive: true },
  );
  await cp(
    path.join(repoRoot, "packages/shared/src/i18n"),
    path.join(root, "packages/shared/src/i18n"),
    { recursive: true },
  );
  rmSync(path.join(root, "packages/shared/src/i18n/generated"), {
    recursive: true,
    force: true,
  });
  return root;
}

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe("generated-source vitest setup", () => {
  it("points at the generator that owns the keyword modules", () => {
    expect(existsSync(keywordGeneratorPath)).toBe(true);
  });

  it("materializes the core keyword module the source alias imports", async () => {
    const root = await fixtureRoot();
    const generated = path.join(
      root,
      CORE_GENERATED_KEYWORD_DATA_RELATIVE_PATH,
    );
    expect(existsSync(generated)).toBe(false);

    expect(materializeGeneratedSources(root)).toBe(true);

    expect(existsSync(generated)).toBe(true);
    expect(await readFile(generated, "utf8")).toContain(
      "VALIDATION_KEYWORD_LOCALES",
    );
  });

  it("regenerates when keyword inputs change after an earlier run", async () => {
    const root = await fixtureRoot();
    expect(materializeGeneratedSources(root)).toBe(true);
    const generated = path.join(
      root,
      CORE_GENERATED_KEYWORD_DATA_RELATIVE_PATH,
    );
    const before = await readFile(generated, "utf8");
    const input = path.join(
      root,
      "packages/shared/src/i18n/keywords/validate.keywords.json",
    );
    const originalInput = await readFile(input, "utf8");
    const changedInput = originalInput.replace(
      '        "build an app",',
      '        "build an app",\n        "__generated_refresh_probe__",',
    );
    expect(changedInput).not.toBe(originalInput);
    await writeFile(input, changedInput);

    expect(materializeGeneratedSources(root)).toBe(true);
    const after = await readFile(generated, "utf8");
    expect(after).not.toBe(before);
    expect(after).toContain("__generated_refresh_probe__");
  });

  it("repairs a partial generated-output set", async () => {
    const root = await fixtureRoot();
    expect(materializeGeneratedSources(root)).toBe(true);
    const sharedJavaScriptOutput = path.join(
      root,
      "packages/shared/src/i18n/generated/validation-keyword-data.js",
    );
    rmSync(sharedJavaScriptOutput);
    expect(existsSync(sharedJavaScriptOutput)).toBe(false);

    expect(materializeGeneratedSources(root)).toBe(true);
    expect(existsSync(sharedJavaScriptOutput)).toBe(true);
  });

  it("fails loudly when the generator is missing instead of leaving suites unresolved", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "generated-sources-empty-"));
    tempRoots.push(root);

    expect(() => materializeGeneratedSources(root)).toThrow();
  });

  it("leaves this checkout's generated module in place through the default export", () => {
    setup();

    expect(existsSync(coreGeneratedKeywordDataPath)).toBe(true);
  });

  it("resolves the exact module core's i18n barrel imports", async () => {
    const barrel = await readFile(
      path.join(repoRoot, "packages/core/src/i18n/validation-keywords.ts"),
      "utf8",
    );

    expect(barrel).toContain("./generated/validation-keyword-data.ts");
  });
});

describe("plugin-computeruse vitest lane", () => {
  it("wires the generated-source global setup alongside its core source alias", async () => {
    const config = await readFile(
      path.join(repoRoot, "plugins/plugin-computeruse/vitest.config.ts"),
      "utf8",
    );

    expect(config).toContain("buildWorkspaceSourceAliases");
    expect(config).toContain("generated-sources.setup.ts");
    expect(config).toContain("globalSetup");
  });
});
