/** Operation identities come from actual capability/scoped-action declarations. */
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPluginViewInventory } from "../lib/plugin-view-inventory.ts";

test("inventories scoped operations and rejects ambiguous operation identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "view-operations-"));
  const builtin = "packages/agent/src/api/builtin-views.ts";
  const source = "plugins/plugin-fixture/src/index.ts";
  try {
    await mkdir(join(root, "packages/agent/src/api"), { recursive: true });
    await writeFile(join(root, builtin), "export const BUILTIN_VIEWS = []; ");
    await mkdir(join(root, "plugins/plugin-fixture/src"), { recursive: true });
    await writeFile(
      join(root, "plugins/plugin-fixture/package.json"),
      JSON.stringify({
        name: "@elizaos/plugin-fixture",
        source: "./src/index.ts",
      }),
    );
    const discover = () =>
      discoverPluginViewInventory({ repoRoot: root, files: [source, builtin] });
    const write = async (names: string[]) =>
      writeFile(
        join(root, source),
        `import type { Plugin } from "@elizaos/core";
      export const plugin: Plugin = { name:"fixture", description:"fixture", views:[{
        id:"fixture",label:"Fixture",modalities:["gui"],path:"/fixture",componentExport:"Fixture",bundlePath:"dist/views/bundle.js",
        scopedActions:${JSON.stringify(names.map((name) => ({ name, description: name, steps: [{ kind: "agent-click", target: "add" }] })))}
      }]};`,
      );
    await write(["VIEW_FIXTURE_ADD", "VIEW_FIXTURE_RETRY"]);
    expect(discover().views[0].operationIds).toEqual([
      "VIEW_FIXTURE_ADD",
      "VIEW_FIXTURE_RETRY",
    ]);
    await write(["VIEW_FIXTURE_ADD", "VIEW_FIXTURE_ADD"]);
    expect(discover).toThrow("repeats operation VIEW_FIXTURE_ADD");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
