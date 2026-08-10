/**
 * Emit a paths-free tsconfig.json next to the built entry.
 *
 * Bun applies the nearest tsconfig's `compilerOptions.paths` to module
 * resolution AT RUNTIME. Source typechecking resolves built workspace package
 * declarations through node_modules, and `bun dist/index.js` must resolve the
 * corresponding runtime exports there. The empty tsconfig here shadows the
 * package one for anything run from inside dist/, keeping the built entry
 * independent of caller-provided workspace aliases.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const distDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
);
writeFileSync(
  path.join(distDir, "tsconfig.json"),
  `${JSON.stringify({ compilerOptions: {} }, null, 2)}\n`,
);
