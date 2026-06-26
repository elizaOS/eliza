import { execSync } from "node:child_process";

console.log("Building Nostr plugin (TypeScript)...");
execSync("bunx tsc -p tsconfig.json --noCheck", { stdio: "inherit" });
console.log("Build complete.");
