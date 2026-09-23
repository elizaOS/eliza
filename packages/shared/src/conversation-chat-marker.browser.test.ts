/** Bundles the shared root's local module graph to prevent server-only marker
 * helpers from entering renderer imports; external packages retain their own contracts. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const sourceRoot = path.dirname(fileURLToPath(import.meta.url));

function bundleSharedRoot(includeServerLeaf = false) {
  return build({
    stdin: {
      resolveDir: sourceRoot,
      contents: `export * from "./index.ts";${includeServerLeaf ? 'export * from "./conversation-chat-marker.ts";' : ""}`,
    },
    bundle: true,
    platform: "browser",
    write: false,
    logLevel: "silent",
    plugins: [
      {
        name: "shared-renderer-runtime-boundary",
        setup(builder) {
          builder.onResolve(
            { filter: /^@elizaos\/core(?:\/|$)/ },
            ({ importer }) => ({
              errors: [
                {
                  text: `Node runtime reached shared renderer graph from ${importer}`,
                },
              ],
            }),
          );
          builder.onResolve({ filter: /^[^./]/ }, ({ path }) => ({
            path,
            external: true,
          }));
        },
      },
    ],
  });
}

describe("shared renderer import boundary", () => {
  it("bundles the actual shared root without pulling in the agent kernel", async () => {
    const result = await bundleSharedRoot();
    expect(result.outputFiles?.[0]?.text.length).toBeGreaterThan(0);
  });

  it("rejects re-exporting the server marker helper through that root", async () => {
    await expect(bundleSharedRoot(true)).rejects.toThrow(
      "Node runtime reached shared renderer graph",
    );
  });
});
