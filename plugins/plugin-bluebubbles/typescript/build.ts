import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

const distDir = join(import.meta.dirname, "dist");

// Clean
rmSync(distDir, { recursive: true, force: true });

// Build
execSync("bunx tsc -p tsconfig.json", {
	cwd: import.meta.dirname,
	stdio: "inherit",
});

console.log("Build complete: plugin-bluebubbles");
