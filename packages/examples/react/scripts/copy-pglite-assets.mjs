import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageEntry = require.resolve("@electric-sql/pglite");
const packageDist = path.dirname(packageEntry);
const outputDir = path.resolve(__dirname, "..", "public", "pglite");

fs.mkdirSync(outputDir, { recursive: true });

for (const filename of ["pglite.data", "pglite.wasm"]) {
  fs.copyFileSync(
    path.join(packageDist, filename),
    path.join(outputDir, filename),
  );
}
