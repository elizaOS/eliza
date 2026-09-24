/** Verifies the renderer's real pure-contract bundle and rejects runtime imports. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const entry = fileURLToPath(new URL("./core-browser.ts", import.meta.url));
describe("renderer core contract projection", () => {
  it("bundles canonical contracts without Node runtime modules", async () => {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    expect(result.outputFiles[0].text).toContain("isViewVisible");
    expect(
      Object.keys(result.metafile.inputs).some((input) =>
        /core\/src\/(?:runtime|index|utils)\.ts$/.test(input),
      ),
    ).toBe(false);
    expect(
      Object.values(result.metafile.outputs).flatMap(
        (output) => output.imports,
      ),
    ).toEqual([]);
  });

  it("bundles shared renderer configuration against the same contracts", async () => {
    const shared = path.resolve(path.dirname(entry), "../../../shared/src");
    const result = await build({
      entryPoints: [
        path.join(shared, "config/plugin-auto-enable-engine.ts"),
        path.join(shared, "config/boot-config-store.ts"),
        path.join(shared, "settings-debug.ts"),
        path.join(shared, "connectors.ts"),
        path.join(shared, "text/template-rendering.ts"),
        path.join(shared, "conversation-chat-marker.ts"),
        path.join(shared, "recent-messages-state.ts"),
      ],
      alias: { "@elizaos/core": entry },
      bundle: true,
      outdir: "renderer-contract-test",
      platform: "browser",
      format: "esm",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    expect(result.outputFiles).toHaveLength(7);
    expect(
      Object.values(result.metafile.outputs).flatMap(
        (output) => output.imports,
      ),
    ).toEqual([]);
  });

  it("cannot supply AgentRuntime to a renderer consumer", async () => {
    await expect(
      build({
        stdin: {
          contents:
            'import { AgentRuntime } from "./core-browser.ts"; new AgentRuntime({});',
          resolveDir: path.dirname(entry),
        },
        bundle: true,
        platform: "browser",
        write: false,
        logLevel: "silent",
      }),
    ).rejects.toThrow("No matching export");
  });
});
