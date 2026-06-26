import { execSync, spawnSync } from "node:child_process";
import { join } from "node:path";

const distDir = join(import.meta.dirname, "dist");
const rmRecursiveScript = join(
	import.meta.dirname,
	"..",
	"..",
	"packages",
	"scripts",
	"rm-path-recursive.mjs",
);

function rmRecursive(targetPath: string) {
	const result = spawnSync(process.execPath, [rmRecursiveScript, targetPath], {
		stdio: "inherit",
	});
	if (result.status !== 0) {
		throw new Error(
			`failed to remove generated BlueBubbles build output ${targetPath}`,
		);
	}
}

// Clean
rmRecursive(distDir);

// Build
execSync("bunx tsc -p tsconfig.json --noCheck", {
	cwd: import.meta.dirname,
	stdio: "inherit",
});

console.log("Build complete: plugin-bluebubbles");
