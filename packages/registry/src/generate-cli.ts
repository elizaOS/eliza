/**
 * Regenerates the committed community registry wire artifact on explicit invocation.
 * It is an executable entrypoint and must never be exported by the importable package API.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateRegistry } from "./generate.ts";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outputPath = path.join(packageRoot, "generated-registry.json");
const registry = generateRegistry();

fs.writeFileSync(outputPath, `${JSON.stringify(registry, null, 2)}\n`);
const count = Object.keys(registry.registry).length;
console.log(`Generated ${outputPath} (${count} third-party entries)`);
