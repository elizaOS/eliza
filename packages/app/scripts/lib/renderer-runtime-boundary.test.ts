/** Exercises the renderer runtime boundary with real Vite tree-shaking over a mixed package barrel. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { rejectRuntimeInRendererPlugin } from "./renderer-runtime-boundary.ts";

async function bundle(entry: string) {
  const directory = await mkdtemp(join(tmpdir(), "renderer-boundary-"));
  try {
    const fixture = join(directory, "node_modules/@fixture/shared");
    await mkdir(fixture, { recursive: true });
    const core = join(directory, "node_modules/@elizaos/core");
    await mkdir(core, { recursive: true });
    await writeFile(
      join(core, "package.json"),
      JSON.stringify({
        name: "@elizaos/core",
        type: "module",
        exports: { "./errors": "./errors.js" },
      }),
    );
    await writeFile(
      join(core, "errors.js"),
      "export class ElizaError extends Error {}",
    );
    await Promise.all([
      writeFile(join(directory, "entry.js"), entry),
      writeFile(
        join(fixture, "package.json"),
        JSON.stringify({
          name: "@fixture/shared",
          type: "module",
          sideEffects: false,
          exports: "./index.js",
        }),
      ),
      writeFile(
        join(fixture, "index.js"),
        'export { label } from "./value.js"; export { migrate } from "./migration.js";',
      ),
      writeFile(join(fixture, "value.js"), 'export const label = "ready";'),
      writeFile(
        join(fixture, "migration.js"),
        'import { ElizaError } from "@elizaos/core"; export function migrate() { throw new ElizaError("invalid", { code: "INVALID" }); }',
      ),
    ]);
    return await build({
      root: directory,
      configFile: false,
      logLevel: "silent",
      plugins: [rejectRuntimeInRendererPlugin()],
      build: {
        write: false,
        minify: false,
        lib: {
          entry: join(directory, "entry.js"),
          formats: ["es"],
          fileName: "fixture",
        },
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("renderer runtime boundary", () => {
  it("discards unused runtime exports from a shared barrel", async () => {
    const result = await bundle('export { label } from "@fixture/shared";');
    const outputs = Array.isArray(result) ? result : [result];
    for (const output of outputs) {
      if (!("output" in output)) throw new Error("Expected a completed build");
      const chunk = output.output.find((item) => item.type === "chunk");
      expect(chunk?.code).toContain('"ready"');
      expect(chunk?.imports).toEqual([]);
    }
  });

  it("bundles a pure core leaf without loading the runtime", async () => {
    const result = await bundle(
      'export { ElizaError } from "@elizaos/core/errors";',
    );
    const outputs = Array.isArray(result) ? result : [result];
    for (const output of outputs) {
      if (!("output" in output)) throw new Error("Expected a completed build");
      const chunk = output.output.find((item) => item.type === "chunk");
      expect(chunk?.code).toContain("extends Error");
      expect(chunk?.imports).toEqual([]);
    }
  });

  it.each([
    'import "node:fs"; export const ready = true;',
    'export { readFile } from "fs/promises";',
    'export async function load() { return import("@elizaos/agent"); }',
    'export { migrate } from "@fixture/shared";',
    'import "@elizaos/core"; export const ready = true;',
    'export async function load() { return import("@elizaos/core"); }',
  ])("rejects retained runtime dependency: %s", async (entry) => {
    await expect(bundle(entry)).rejects.toThrow("survived in renderer chunk");
  });
});
