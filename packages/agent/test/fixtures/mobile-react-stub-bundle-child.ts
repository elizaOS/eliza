/**
 * Child fixture for the mobile React stub e2e: bundles a namespace-importing
 * entry with Bun.build, resolving `react`/`react-dom` to the real
 * `scripts/mobile-stubs` files the same way build-mobile-bundle.ts does, for
 * the Bun (iOS) and browser (iOS JSContext) targets. Each bundle then runs in
 * a fresh Bun process. Results print as one `STUB_RESULT=<json>` line.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workDir = process.argv[2];
if (!workDir) throw new Error("Expected a work directory argument.");
const stubsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts/mobile-stubs",
);
const stubAliases: Record<string, string> = {
  react: path.join(stubsDir, "react.ts"),
  "react-dom": path.join(stubsDir, "react-dom.ts"),
  "react-dom/client": path.join(stubsDir, "react-dom.ts"),
};

const entry = path.join(workDir, "entry.ts");
writeFileSync(
  entry,
  `import * as React from "react";
import { useState } from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
const [state] = React.useState("initial");
console.log(JSON.stringify({
  reactKeys: Object.keys(React),
  reactDomKeys: Object.keys(ReactDOM),
  state,
  namedUseState: typeof useState,
  createElement: typeof React.createElement,
  fragment: typeof React.Fragment,
  version: React.version,
  createPortal: typeof ReactDOM.createPortal,
  createRoot: typeof ReactDOMClient.createRoot,
}));
`,
);

const results: Record<string, unknown> = {};
for (const target of ["bun", "browser"] as const) {
  const outdir = path.join(workDir, target);
  mkdirSync(outdir, { recursive: true });
  const build = await Bun.build({
    entrypoints: [entry],
    outdir,
    target,
    format: "esm",
    plugins: [
      {
        name: "mobile-react-stubs",
        setup(builder) {
          builder.onResolve(
            { filter: /^react(?:-dom(?:\/client)?)?$/ },
            (args) => ({ path: stubAliases[args.path], namespace: "file" }),
          );
        },
      },
    ],
  });
  if (!build.success) {
    throw new AggregateError(build.logs, `Bun.build failed for ${target}`);
  }
  const run = Bun.spawnSync([process.execPath, path.join(outdir, "entry.js")]);
  if (run.exitCode !== 0) {
    throw new Error(`${target} bundle exited ${run.exitCode}: ${run.stderr}`);
  }
  results[target] = JSON.parse(run.stdout.toString());
}
console.log(`STUB_RESULT=${JSON.stringify(results)}`);
