import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const read = (path) => readFileSync(join(root, path), "utf8");

describe("browser extension workspace", () => {
  test("keeps Chrome and Safari packages registered as workspaces", () => {
    const pkg = JSON.parse(read("package.json"));

    expect(pkg.workspaces).toEqual(["chrome", "safari"]);
    expect(pkg.scripts["build:chrome"]).toContain("chrome");
    expect(pkg.scripts["build:safari"]).toContain("safari");
  });

  test("shares runtime and type definitions between extension targets", () => {
    expect(read("shared/types.ts")).toContain("ExtensionConfig");
    expect(read("shared/eliza-runtime-full.ts")).toContain("AgentRuntime");
  });
});
