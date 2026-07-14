/**
 * Rejects non-regular build entries and absolute checkout paths from every
 * emitted local-inference artifact before npm packaging.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function runtimeOutputFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = join(directory, entry.name);
		if (entry.isDirectory()) return runtimeOutputFiles(entryPath);
		if (entry.isFile()) return [entryPath];
		throw new Error(
			`[plugin-local-inference] built runtime contains a non-regular entry: ${entryPath}`,
		);
	});
}

export function assertRelocatableRuntimeOutput(
	directory: string,
	forbiddenRoot: string,
): void {
	const forbiddenBytes = Buffer.from(forbiddenRoot);
	const leakedFiles = runtimeOutputFiles(directory).filter((file) =>
		readFileSync(file).includes(forbiddenBytes),
	);
	if (leakedFiles.length > 0) {
		throw new Error(
			`[plugin-local-inference] built runtime contains the source checkout path: ${leakedFiles.join(", ")}`,
		);
	}
}
