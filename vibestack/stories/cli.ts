#!/usr/bin/env node
// `node <tool>/stories/cli.ts gen [--watch] [--check]`, run from the project whose components it reads.
import { watch } from "node:fs";
import { enableCompileCache } from "node:module";

// Before the TypeScript compiler loads: most of a run that finds nothing changed is compiling it.
enableCompileCache();
const { generator, listener } = await import("./emit.ts");

const argv = process.argv.slice(2);
if (argv[0] !== "gen") {
  console.error("usage: stories gen [--watch] [--check]");
  process.exit(2);
}

const root = process.cwd();
const run = generator({ root });
/** Brings the output up to date and says what changed, if anything did; false when a component could not be given stories. */
function once(): boolean {
  const start = performance.now();
  const { index, written, removed, analyzed, diagnostics } = run();
  const stories = index.components.reduce((sum, c) => sum + c.stories.length, 0);
  if (analyzed || written.length || removed.length)
    console.log(`${index.components.length} components, ${stories} stories: ${analyzed} files analyzed, ${written.length} written, ${removed.length} removed in ${Math.round(performance.now() - start)} ms`);
  for (const line of diagnostics) console.error(`✗ ${line}`);
  return diagnostics.length === 0;
}

const ok = once();
if (argv.includes("--watch")) {
  const changed = listener(root, undefined, once);
  watch(root, { recursive: true }, (_, file) => file && changed(file));
} else if (argv.includes("--check") && !ok) process.exit(1);
