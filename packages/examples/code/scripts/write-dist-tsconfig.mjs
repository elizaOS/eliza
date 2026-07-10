/**
 * Emit a paths-free tsconfig.json next to the built entry.
 *
 * Bun applies the nearest tsconfig's `compilerOptions.paths` to module
 * resolution AT RUNTIME. This package's tsconfig extends the repo's
 * `tsconfig.dist-paths.json`, which maps the externalized workspace packages
 * (`@elizaos/core`, `@elizaos/plugin-*`) to their `dist/*.d.ts` — correct for
 * typechecking, fatal for `bun dist/index.js`: Bun loads the .d.ts, strips the
 * types, and a value re-export like plugin-openai's `export default
 * openaiPlugin;` becomes a ReferenceError. The empty tsconfig here shadows the
 * package one for anything run from inside dist/, so Bun falls back to normal
 * node_modules resolution and loads the real runtime entries.
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
