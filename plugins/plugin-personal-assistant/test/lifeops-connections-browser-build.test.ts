/**
 * Verifies the LifeOps connections view compiles against the browser source
 * facade used by the consolidated app build rather than a test UI stub.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, it } from "vitest";

const pluginRoot = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);
const repositoryRoot = path.resolve(pluginRoot, "../..");
const viewEntry = path.join(
  pluginRoot,
  "src/components/lifeops-connections/lifeops-connections-view-bundle.ts",
);
const uiBrowserFacade = path.join(repositoryRoot, "packages/ui/src/browser.ts");
const sharedSource = path.join(repositoryRoot, "packages/shared/src");

function isBareImport(id: string): boolean {
  return !id.startsWith(".") && !path.isAbsolute(id) && !id.startsWith("\0");
}

function isSourceAliasedImport(id: string): boolean {
  return id === "@elizaos/ui" || id.startsWith("@elizaos/shared");
}

describe("LifeOps connections browser build", () => {
  it("compiles the real view through the app's @elizaos/ui source alias", async () => {
    await build({
      configFile: false,
      logLevel: "silent",
      resolve: {
        alias: [
          { find: /^@elizaos\/ui$/, replacement: uiBrowserFacade },
          {
            find: /^@elizaos\/shared$/,
            replacement: path.join(sharedSource, "index.ts"),
          },
          {
            find: /^@elizaos\/shared\/(.+)$/,
            replacement: `${sharedSource}/$1`,
          },
        ],
      },
      build: {
        write: false,
        lib: {
          entry: viewEntry,
          formats: ["es"],
        },
        rollupOptions: {
          external: (id) => isBareImport(id) && !isSourceAliasedImport(id),
        },
      },
    });
  }, 120_000);
});
