/** Exercises canonical emitted Node module loading and the production plugin normalizer. */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

it("loads the relocated package root through the runtime plugin boundary", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mcp-relocated-build-"));
  const buildRoot = path.join(root, "build");
  const deployed = path.join(root, "deployed");
  const stagedPackage = path.join(buildRoot, "plugins/plugin-mcp");
  const repository = path.resolve(packageRoot, "../..");
  mkdirSync(stagedPackage, { recursive: true });
  mkdirSync(deployed);
  try {
    for (const file of ["src", "build.ts", "package.json", "tsconfig.json", "tsconfig.build.json"])
      cpSync(path.join(packageRoot, file), path.join(stagedPackage, file), { recursive: true });
    for (const file of ["plugin-build.ts", "plugin-build-externals.ts"])
      cpSync(path.join(repository, "plugins", file), path.join(buildRoot, "plugins", file));
    symlinkSync(path.join(repository, "packages"), path.join(buildRoot, "packages"), "junction");
    symlinkSync(
      path.join(repository, "node_modules"),
      path.join(buildRoot, "node_modules"),
      "junction"
    );
    execFileSync("bun", ["run", "build.ts"], { cwd: stagedPackage, stdio: "pipe" });
    cpSync(path.join(stagedPackage, "dist"), path.join(deployed, "dist"), { recursive: true });
    cpSync(path.join(stagedPackage, "package.json"), path.join(deployed, "package.json"));
    symlinkSync(
      path.join(packageRoot, "node_modules"),
      path.join(deployed, "node_modules"),
      "junction"
    );
    // Deployment must work after the original source and its dependency links disappear.
    rmSync(buildRoot, { recursive: true, force: true });
    const normalizer = path.resolve(
      packageRoot,
      "../../packages/agent/src/runtime/plugin-types.ts"
    );
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--input-type=module",
        "--eval",
        `import assert from "node:assert/strict";
     import { pathToFileURL } from "node:url";
     const module = await import("@elizaos/plugin-mcp");
     const { findRuntimePluginExport } = await import(pathToFileURL(process.argv[1]).href);
     const plugin = findRuntimePluginExport(module);
     assert(plugin, "The emitted module did not expose a runtime plugin");
     assert.equal(plugin, module.default);
     console.log(JSON.stringify({ name: plugin.name }));`,
        normalizer,
      ],
      { cwd: deployed, encoding: "utf8" }
    );
    expect(JSON.parse(output)).toEqual({ name: "mcp" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
