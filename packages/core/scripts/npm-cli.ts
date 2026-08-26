/** Resolves a Node-hosted npm CLI invocation for Core build verification across supported platforms. */
import { existsSync } from "node:fs";
import path from "node:path";

export interface NpmCliInvocation {
	command: string;
	args: string[];
}

interface ResolveNpmCliOptions {
	platform?: NodeJS.Platform;
	pathValue?: string;
	fileExists?: (filePath: string) => boolean;
}

function normalizePathEntry(entry: string): string {
	const trimmed = entry.trim();
	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

/**
 * Resolve npm without asking a Windows shell to interpret `npm.cmd`.
 *
 * Core's build runs under Bun, so `process.execPath` is not Node. Windows npm
 * launchers are `.cmd` files, so inspect PATH for a complete Node distribution
 * and execute npm's JavaScript entrypoint through that distribution's
 * `node.exe`. POSIX npm entries may themselves be shell wrappers (for example
 * mise's reshim wrapper), so invoke the discovered executable directly.
 */
export function resolveNpmCliInvocation(
	args: readonly string[],
	options: ResolveNpmCliOptions = {},
): NpmCliInvocation {
	const platform = options.platform ?? process.platform;
	const fileExists = options.fileExists ?? existsSync;
	const pathValue = options.pathValue ?? process.env.PATH ?? "";
	if (platform !== "win32") {
		for (const rawEntry of pathValue.split(":")) {
			const entry = normalizePathEntry(rawEntry);
			if (entry.length === 0) continue;
			const npmCandidate = path.posix.join(entry, "npm");
			if (fileExists(npmCandidate)) {
				return { command: npmCandidate, args: [...args] };
			}
		}
		return { command: "npm", args: [...args] };
	}

	for (const rawEntry of pathValue.split(";")) {
		const entry = normalizePathEntry(rawEntry);
		if (entry.length === 0) continue;

		const nodeExecutable = path.win32.join(entry, "node.exe");
		const npmCommand = path.win32.join(entry, "npm.cmd");
		const npmCli = path.win32.join(
			entry,
			"node_modules",
			"npm",
			"bin",
			"npm-cli.js",
		);
		if (
			fileExists(nodeExecutable) &&
			fileExists(npmCommand) &&
			fileExists(npmCli)
		) {
			return {
				command: nodeExecutable,
				args: [npmCli, ...args],
			};
		}
	}

	return { command: "npm", args: [...args] };
}
