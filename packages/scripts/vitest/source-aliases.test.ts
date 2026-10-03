/** Public core leaves must share source module identity without opening private subpaths. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { buildWorkspaceSourceAliases } from "./source-aliases.ts";

test("core root and declared leaves share a singleton while private paths stay unaliased", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "core-source-aliases-"));
  try {
    const source = path.join(root, "packages/core/src");
    mkdirSync(source, { recursive: true });
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] }),
    );
    writeFileSync(
      path.join(root, "packages/core/package.json"),
      JSON.stringify({
        name: "@elizaos/core",
        type: "module",
        exports: {
          ".": { import: "./dist/index.js" },
          "./leaf": {
            "eliza-source": "./src/leaf.ts",
            import: "./dist/leaf.js",
          },
          "./private": null,
        },
      }),
    );
    writeFileSync(
      path.join(source, "singleton.ts"),
      "export const logger = {};\n",
    );
    for (const name of ["index", "leaf"]) {
      writeFileSync(
        path.join(source, `${name}.ts`),
        'export { logger } from "./singleton.ts";\n',
      );
    }
    writeFileSync(
      path.join(source, "private.ts"),
      "export const secret = true;\n",
    );
    const aliases = buildWorkspaceSourceAliases(root);
    const resolveSource = (specifier: string) => {
      const alias = aliases.find(({ find }) => find.test(specifier));
      assert.ok(alias, `Missing public source alias: ${specifier}`);
      return specifier.replace(alias.find, alias.replacement);
    };
    const rootModule = await import(
      pathToFileURL(resolveSource("@elizaos/core")).href
    );
    const leafModule = await import(
      pathToFileURL(resolveSource("@elizaos/core/leaf")).href
    );
    assert.strictEqual(rootModule.logger, leafModule.logger);
    for (const specifier of [
      "@elizaos/core/private",
      "@elizaos/core/private.js",
      "@elizaos/core/undeclared",
      "@elizaos/core/leaf/../private",
    ]) {
      assert.equal(
        aliases.some(({ find }) => find.test(specifier)),
        false,
        specifier,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
