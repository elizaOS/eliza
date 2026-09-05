/** Builds real temporary workspace imports through Bun with incomplete and complete exported output. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hasResolvableWorkspaceEntry } from "./mobile-workspace-entry.mjs";

for (const built of [false, true]) {
  test(`mobile import uses ${built ? "exported output" : "source when only a view bundle exists"}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mobile-entry-"));
    try {
      const packageDir = path.join(root, "node_modules/@elizaos/entry-fixture");
      await mkdir(path.join(packageDir, "dist/views"), { recursive: true });
      await mkdir(path.join(packageDir, "src"));
      await writeFile(
        path.join(packageDir, "package.json"),
        JSON.stringify({
          name: "@elizaos/entry-fixture",
          type: "module",
          exports: {
            ".": {
              node: { import: "./dist/node/index.node.js" },
              default: "./dist/node/index.node.js",
            },
          },
        }),
      );
      await writeFile(
        path.join(packageDir, "dist/views/bundle.js"),
        "export const view = true;",
      );
      await writeFile(
        path.join(packageDir, "src/index.node.ts"),
        "export const answer = 41 + 1;",
      );
      if (built) {
        await mkdir(path.join(packageDir, "dist/node"));
        await writeFile(
          path.join(packageDir, "dist/node/index.node.js"),
          "export const answer = 40 + 3;",
        );
      }
      const entry = path.join(root, "entry.ts");
      await writeFile(
        entry,
        'import { answer } from "@elizaos/entry-fixture"; export default answer;',
      );
      assert.equal(
        hasResolvableWorkspaceEntry("@elizaos/entry-fixture", packageDir),
        built,
      );
      const output = await Bun.build({
        entrypoints: [entry],
        target: "bun",
        plugins: [
          {
            name: "workspace-entry",
            setup(build) {
              build.onResolve(
                { filter: /^@elizaos\/entry-fixture$/ },
                (args) =>
                  hasResolvableWorkspaceEntry(args.path, packageDir)
                    ? undefined
                    : { path: path.join(packageDir, "src/index.node.ts") },
              );
            },
          },
        ],
      });
      assert.equal(output.success, true, output.logs.map(String).join("\n"));
      const artifact = path.join(root, "bundle.mjs");
      await writeFile(artifact, await output.outputs[0].text());
      assert.equal((await import(artifact)).default, built ? 43 : 42);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
