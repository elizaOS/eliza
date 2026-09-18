/** Optional local credentials for the opt-in live Playwright harness. */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "dotenv";

export function findEnvFile(startDir = process.cwd()): string | undefined {
	let directory = startDir;
	for (;;) {
		for (const filename of [".env", ".env.local"]) {
			const candidate = join(directory, filename);
			if (existsSync(candidate)) return candidate;
		}
		const parent = dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}
export function loadEnvFile(): boolean {
	const path = findEnvFile();
	if (!path) return false;
	const result = config({ path });
	if (result.error)
		throw new Error(
			`Failed to parse .env file at ${path}: ${result.error.message}`,
		);
	return true;
}
