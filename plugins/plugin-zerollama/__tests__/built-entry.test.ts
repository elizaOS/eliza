/** Exercises canonical emitted Node module loading and the production plugin normalizer. */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

it("loads the canonical Node build through the runtime plugin boundary", () => {
  execFileSync("bun", ["run", "build.ts"], {
    cwd: packageRoot,
    stdio: "pipe",
  });
  const emitted = path.join(packageRoot, "dist/node/index.node.js");
  const normalizer = path.resolve(packageRoot, "../../packages/agent/src/runtime/plugin-types.ts");
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `import assert from "node:assert/strict";
     import { pathToFileURL } from "node:url";
     const module = await import(pathToFileURL(process.argv[1]).href);
     const { findRuntimePluginExport } = await import(pathToFileURL(process.argv[2]).href);
     const plugin = findRuntimePluginExport(module);
     assert(plugin, "The emitted module did not expose a runtime plugin");
     assert.equal(plugin, module.default);
     console.log(JSON.stringify({ name: plugin.name }));`,
      emitted,
      normalizer,
    ],
    { cwd: packageRoot, encoding: "utf8" }
  );
  expect(JSON.parse(output)).toEqual({ name: "zerollama" });
}, 60_000);
