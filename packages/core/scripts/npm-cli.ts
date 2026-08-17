/** Resolves the npm CLI invocation used by Core build verification across supported platforms. */
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
 * Core's build runs under Bun, so `process.execPath` is not Node. Instead,
 * inspect PATH for a complete Node distribution and execute npm's JavaScript
 * entrypoint through that distribution's `node.exe`. Non-Windows platforms
 * keep the existing direct `npm` invocation.
 */
export function resolveNpmCliInvocation(
	args: readonly string[],
	options: ResolveNpmCliOptions = {},
): NpmCliInvocation {
	const platform = options.platform ?? process.platform;
	if (platform !== "win32") {
		return { command: "npm", args: [...args] };
	}

	const fileExists = options.fileExists ?? existsSync;
	const pathValue = options.pathValue ?? process.env.PATH ?? "";
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
