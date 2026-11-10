/**
 * Child fixture for host-selected mobile stubs: bundles an entry that imports a
 * host-stubbed package, its subpath and a longer source alias, with the host
 * resolver ahead of a resolver that would otherwise claim the package. Prints one
 * `HOST_STUB_RESULT=<json>` line with the bundle's inputs and observed behaviour.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addStubAliasResolver,
  mergeMobileStubPlugins,
  parseMobileStubPlugins,
} from "../../scripts/mobile-stub-plugins.ts";

const workDir = process.argv[2];
if (!workDir) throw new Error("Expected a work directory argument.");
const stub = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts/mobile-stubs/null-plugin.ts",
);
const put = (file: string, text: string) => {
  mkdirSync(path.dirname(path.join(workDir, file)), { recursive: true });
  writeFileSync(path.join(workDir, file), text);
};
put(
  "node_modules/heavy/package.json",
  JSON.stringify({ name: "heavy", type: "module", main: "index.js" }),
);
put("node_modules/heavy/index.js", 'export const value = "heavy-code";');
put("node_modules/heavy/sub.js", 'export const sub = "heavy-sub";');
put("dedupe/heavy.ts", 'export const value = "dedupe-copy";');
put("keep.ts", 'export const kept = "source-alias";');
put(
  "entry.ts",
  `import { value } from "heavy";
import * as sub from "heavy/sub.js";
import { kept } from "kept/keep";
let failed = false;
try { sub.default.anything(); } catch (error) { failed = error.code === "MOBILE_CAPABILITY_UNAVAILABLE"; }
console.log(JSON.stringify({ value: typeof value, sub: typeof sub, failed, kept }));
`,
);
const aliases = mergeMobileStubPlugins(
  { "kept/keep": path.join(workDir, "keep.ts") },
  parseMobileStubPlugins("heavy, kept"),
  stub,
);
const outdir = path.join(workDir, "out");
const build = await Bun.build({
  entrypoints: [path.join(workDir, "entry.ts")],
  outdir,
  target: "bun",
  format: "esm",
  metafile: true,
  plugins: [
    {
      name: "host-stubs",
      setup(b) {
        addStubAliasResolver(b, aliases, ["heavy", "kept"]);
      },
    },
    {
      name: "dedupe",
      setup(b) {
        b.onResolve({ filter: /^heavy$/ }, () => ({
          path: path.join(workDir, "dedupe/heavy.ts"),
        }));
      },
    },
  ],
});
if (!build.success) throw new AggregateError(build.logs, "Bun.build failed");
const run = Bun.spawnSync([process.execPath, path.join(outdir, "entry.js")]);
if (run.exitCode !== 0)
  throw new Error(`bundle exited ${run.exitCode}: ${run.stderr}`);
console.log(
  `HOST_STUB_RESULT=${JSON.stringify({
    inputs: Object.keys(build.metafile?.inputs ?? {}),
    run: JSON.parse(run.stdout.toString()),
  })}`,
);
