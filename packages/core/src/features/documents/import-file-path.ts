/**
 * Path policy for DOCUMENT `import_file`. That subaction is USER-role and
 * reads the host filesystem; without a blocklist a planner can copy credential
 * or OS-private files into the document store. `import_url` already has an
 * SSRF guard. Roots are realpathed when they exist so macOS `/etc` →
 * `/private/etc` cannot slip through.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function defaultDocumentImportBlockedRoots(home = homedir()): string[] {
	return [
		path.join(home, ".ssh"),
		path.join(home, ".aws"),
		path.join(home, ".gnupg"),
		path.join(home, ".docker"),
		path.join(home, ".kube"),
		path.join(home, ".netrc"),
		path.join(home, "pvt"),
		"/etc",
		"/proc",
		"/sys",
		"/dev",
		"/root",
	];
}

function resolveExisting(absPath: string): string {
	try {
		return realpathSync(absPath);
	} catch {
		// error-policy:J3 missing or unreadable root/file — keep the lexical
		// absolute so a not-yet-created SSH private-key path is still blocked.
		return path.resolve(absPath);
	}
}

function isWithinRoot(candidate: string, root: string): boolean {
	const relative = path.relative(root, candidate);
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	);
}

export function isBlockedDocumentImportPath(
	filePath: string,
	options: { home?: string; roots?: readonly string[] } = {},
): boolean {
	const configured =
		options.roots ?? defaultDocumentImportBlockedRoots(options.home);
	const roots = [
		...configured.map((root) => path.resolve(root)),
		...configured.map((root) => resolveExisting(root)),
	];
	const candidates = [path.resolve(filePath), resolveExisting(filePath)];
	return candidates.some((candidate) =>
		roots.some((root) => isWithinRoot(candidate, root)),
	);
}
