import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverScenarios, loadAllScenarios } from "../loader.ts";

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
});
