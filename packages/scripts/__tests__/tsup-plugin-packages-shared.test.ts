/**
 * Exercises the shared tsup/esbuild source transformer through a real unbundled build and imported output.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const roots: string[] = [];
const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("shared plugin tsup source rewriting", () => {
  test("rewrites module specifiers without changing import-shaped runtime text", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "plugin-tsup-rewrite-"));
    roots.push(root);
    mkdirSync(path.join(root, "src"));
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    writeFileSync(
      path.join(root, "src", "sibling.ts"),
      "export const value = 7;\n",
    );
    writeFileSync(
      path.join(root, "src", "index.ts"),
      [
        'import { value } from "./sibling";',
        "export const guidance = 'Read from \"./sibling\" for help.';",
        "export const result = value;",
      ].join("\n"),
    );

    process.chdir(root);
    const configModule = await import(
      `${pathToFileURL(path.join(originalCwd, "plugins", "tsup.plugin-packages.shared.ts")).href}?fixture=${Date.now()}`
    );
    const config = configModule.default;
    const resolveFromPlugin = createRequire(
      path.join(originalCwd, "plugins", "plugin-blocker", "package.json"),
    );
    const { build } = await import(resolveFromPlugin.resolve("esbuild"));
    await build({
      absWorkingDir: root,
      entryPoints: config.entry,
      outdir: path.join(root, "dist"),
      format: "esm",
      bundle: false,
      sourcemap: false,
      plugins: config.esbuildPlugins,
    });

    expect(existsSync(path.join(root, "dist", "index.js"))).toBe(true);
    const emitted = readFileSync(path.join(root, "dist", "index.js"), "utf8");
    expect(emitted).toContain('from "./sibling.js"');
    expect(emitted).toContain('Read from "./sibling" for help.');
    const runtime = await import(
      `${pathToFileURL(path.join(root, "dist", "index.js")).href}?run=${Date.now()}`
    );
    expect(runtime).toMatchObject({
      guidance: 'Read from "./sibling" for help.',
      result: 7,
    });
  });
});
