/** Verify the exported workspace sheet against emitted sibling-package JS. */

import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = resolve(import.meta.dirname, "../../..");
const evidence = testOutputPath("mobile-workspace-styles");
mkdirSync(evidence, { recursive: true });
const out = mkdtempSync(join(evidence, "package-")),
  ui = join(out, "node_modules/@elizaos/ui/dist");
const require = createRequire(join(root, "packages/ui/package.json"));
const tailwindVite = require.resolve("@tailwindcss/vite");
const peer = createRequire(tailwindVite);
const { compile } = await import(
  pathToFileURL(peer.resolve("@tailwindcss/node"))
);
const { Scanner } = peer("@tailwindcss/oxide");
const { transformSync } = require("esbuild");
mkdirSync(join(ui, "styles"), { recursive: true });
for (const name of ["mobile-workspaces.css", "tailwind-theme.css"])
  copyFileSync(
    join(root, "packages/ui/src/styles", name),
    join(ui, "styles", name),
  );
const tw = join(out, "node_modules/tailwindcss");
symlinkSync(dirname(require.resolve("tailwindcss/package.json")), tw, "dir");
const emit = (input, output) => {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(
    output,
    transformSync(readFileSync(input, "utf8"), {
      loader: "tsx",
      format: "esm",
      target: "es2022",
    }).code,
  );
};
emit(
  join(root, "plugins/plugin-calendar/src/components/CalendarWorkspace.tsx"),
  join(
    out,
    "node_modules/@elizaos/plugin-calendar/dist/components/CalendarWorkspace.js",
  ),
);
for (const name of ["button", "segmented-control", "popover"])
  emit(
    join(root, "packages/ui/src/components/ui", name + ".tsx"),
    join(ui, "components/ui", name + ".js"),
  );
for (const name of readdirSync(
  join(root, "packages/ui/src/components/composites/page-panel"),
).filter((n) => /\.tsx?$/.test(n)))
  emit(
    join(root, "packages/ui/src/components/composites/page-panel", name),
    join(
      ui,
      "components/composites/page-panel",
      name.replace(/\.tsx?$/, ".js"),
    ),
  );
const result = await compile(
  readFileSync(join(ui, "styles/mobile-workspaces.css"), "utf8"),
  { base: join(ui, "styles"), onDependency() {} },
);
const scanner = new Scanner({ sources: result.sources });
const candidates = scanner.scan(),
  css = result.build(candidates);
for (const selector of [".min-h-24", ".w-64", ".max-h-72"])
  if (!css.includes(selector))
    throw Error("Published workspace failed to include " + selector);
if (css.includes("box-sizing: border-box"))
  throw Error("Workspace emitted a global reset");
writeFileSync(join(evidence, "packed-style.css"), css);
writeFileSync(
  join(evidence, "packed-style.json"),
  JSON.stringify(
    {
      publishedSiblingScan: true,
      candidates: candidates.length,
      scope: css.includes("[data-shared-workspace]"),
      sourceFiles: scanner.scannedFiles,
    },
    null,
    2,
  ),
);
rmSync(out, { recursive: true, force: true });
console.log(
  "PASS: published sibling JS yields scoped Calendar/primitive utilities without reset",
);
