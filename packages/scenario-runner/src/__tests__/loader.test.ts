import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverScenarios,
  listScenarioMetadata,
  loadAllScenarios,
  matchesScenarioFileGlobs,
} from "../loader.ts";

function writeScenario(dir: string, filename: string, body: string): string {
  const fullPath = path.join(dir, filename);
  writeFileSync(fullPath, body, "utf-8");
  return fullPath;
}

describe("loader", () => {
  it("discovers .scenario.ts files recursively and ignores _helpers", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sc-loader-"));
    mkdirSync(path.join(root, "a"));
    mkdirSync(path.join(root, "_helpers"));
    mkdirSync(path.join(root, "a", "nested"));
    writeScenario(path.join(root, "a"), "one.scenario.ts", "");
    writeScenario(path.join(root, "a", "nested"), "two.scenario.ts", "");
    writeScenario(root, "unrelated.ts", "");
    writeScenario(path.join(root, "_helpers"), "hidden.scenario.ts", "");

    const files = await discoverScenarios(root);
    expect(files.map((f) => path.relative(root, f)).sort()).toEqual([
      path.join("a", "nested", "two.scenario.ts"),
      path.join("a", "one.scenario.ts"),
    ]);
  });

  it("loads a scenario via default export and rejects missing id", async () => {
    const goodDir = mkdtempSync(path.join(os.tmpdir(), "sc-loader2a-"));
    writeScenario(
      goodDir,
      "good.scenario.ts",
      `export default { id: "x.test", title: "t", domain: "d", turns: [] };\n`,
    );
    const loaded = await loadAllScenarios(goodDir);
    expect(loaded.map((l) => l.scenario.id)).toEqual(["x.test"]);

    const badDir = mkdtempSync(path.join(os.tmpdir(), "sc-loader2b-"));
    writeScenario(
      badDir,
      "bad.scenario.ts",
      `export default { title: "nope" };\n`,
    );
    await expect(loadAllScenarios(badDir)).rejects.toThrow(/bad\.scenario\.ts/);
  });

  it("filters by id set when provided", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sc-loader3-"));
    writeScenario(
      root,
      "a.scenario.ts",
      `export default { id: "keep.me", title: "t", domain: "d", turns: [] };\n`,
    );
    writeScenario(
      root,
      "b.scenario.ts",
      `export default { id: "drop.me", title: "t", domain: "d", turns: [] };\n`,
    );
    const loaded = await loadAllScenarios(root, new Set(["keep.me"]));
    expect(loaded.map((l) => l.scenario.id)).toEqual(["keep.me"]);
  });

  it("lists scenario ids without importing runtime-only modules", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sc-loader-native-"));
    writeScenario(
      root,
      "native.scenario.ts",
      `import "@elizaos/native-only-test-missing";
import { scenario } from "@elizaos/scenario-schema";
export default scenario({ id: "native.only", title: "t", domain: "d", turns: [] });
`,
    );

    const listed = await listScenarioMetadata(root);
    expect(listed.map((entry) => entry.id)).toEqual(["native.only"]);
    await expect(loadAllScenarios(root)).rejects.toThrow(
      /native-only-test-missing/,
    );
  });

  it("applies pending filtering from static metadata", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sc-loader-pending-"));
    writeScenario(
      root,
      "pending.scenario.ts",
      `import "@elizaos/native-only-test-missing";
import { scenario } from "@elizaos/scenario-schema";
export default scenario({
  id: "pending.only",
  title: "t",
  domain: "d",
  status: "pending",
  turns: [{ kind: "api", name: "nested", method: "GET", path: "/", expect: { status: "success" } }],
});
`,
    );

    const previousIncludePending = process.env.SCENARIO_INCLUDE_PENDING;
    try {
      delete process.env.SCENARIO_INCLUDE_PENDING;
      await expect(listScenarioMetadata(root)).resolves.toEqual([]);

      process.env.SCENARIO_INCLUDE_PENDING = "1";
      const listed = await listScenarioMetadata(root);
      expect(listed.map((entry) => entry.id)).toEqual(["pending.only"]);
    } finally {
      if (previousIncludePending === undefined) {
        delete process.env.SCENARIO_INCLUDE_PENDING;
      } else {
        process.env.SCENARIO_INCLUDE_PENDING = previousIncludePending;
      }
    }
  });

  it("matches shard globs against scenario file paths", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sc-loader4-"));
    mkdirSync(path.join(root, "browser"));
    mkdirSync(path.join(root, "messaging"));

    const browserFile = writeScenario(
      path.join(root, "browser"),
      "keep.scenario.ts",
      `export default { id: "browser.keep", title: "t", domain: "d", turns: [] };\n`,
    );
    writeScenario(
      path.join(root, "messaging"),
      "drop.scenario.ts",
      `export default { id: "messaging.drop", title: "t", domain: "d", turns: [] };\n`,
    );

    const browserGlob = `${root.replace(/\\/g, "/")}/browser/**/*.scenario.ts`;
    expect(matchesScenarioFileGlobs(browserFile, [browserGlob])).toBe(true);

    const loaded = await loadAllScenarios(root, undefined, [browserGlob]);
    expect(loaded.map((l) => l.scenario.id)).toEqual(["browser.keep"]);
  });
});
