import { execSync } from "node:child_process";
import { rmSync } from "node:fs";

console.log("Building Google plugin (TypeScript)...");
rmSync("dist", { recursive: true, force: true });
execSync("bunx tsc -p tsconfig.json", { stdio: "inherit" });
console.log("Build complete.");
