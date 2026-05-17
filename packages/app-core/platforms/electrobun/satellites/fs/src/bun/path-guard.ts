import { existsSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { throwFileSatelliteError } from "./errors.ts";
import type { FileRoot } from "./protocol.ts";

const SENSITIVE_NAMES = new Set([
	".ssh",
	".gnupg",
	".aws",
	".env",
	".env.local",
	".env.production",
	"id_rsa",
	"id_ed25519",
]);

const GENERATED_NAMES = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	".next",
	".turbo",
	".cache",
]);

export type GuardedPath = {
	root: FileRoot;
	absolutePath: string;
	realPath: string;
	exists: boolean;
};

export type ResolvePathOptions = {
	path?: string;
	rootId?: string;
	includeHidden?: boolean;
	allowMissing?: boolean;
};

type RootRecord = FileRoot & {
	realPath: string;
};

export class PathGuard {
	private rootCache: RootRecord[] | null = null;

	constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

	async roots(): Promise<FileRoot[]> {
		return (await this.loadRoots()).map(({ id, path, label }) => ({
			id,
			path,
			...(label === undefined ? {} : { label }),
		}));
	}

	async resolvePath(options: ResolvePathOptions = {}): Promise<GuardedPath> {
		const roots = await this.loadRoots();
		const root = this.selectRoot(roots, options);
		const requested = options.path?.trim();
		const absolutePath =
			requested && path.isAbsolute(requested)
				? path.resolve(requested)
				: path.resolve(root.path, requested ?? ".");
		const resolved = options.allowMissing
			? await this.resolvePossiblyMissing(absolutePath)
			: await this.resolveExisting(absolutePath);

		if (!isInsideRoot(root.realPath, resolved.realPath)) {
			throwFileSatelliteError({
				code: "FS_PATH_OUTSIDE_ROOT",
				message: "Path is outside the allowed filesystem roots.",
				path: absolutePath,
			});
		}

		this.assertAllowed(root.realPath, resolved.realPath, {
			includeHidden: options.includeHidden === true,
		});

		return {
			root: { id: root.id, path: root.path, label: root.label },
			absolutePath,
			realPath: resolved.realPath,
			exists: resolved.exists,
		};
	}

	shouldSkipPath(
		root: FileRoot,
		absolutePath: string,
		includeHidden = false,
	): boolean {
		const normalized = path.resolve(absolutePath);
		try {
			this.assertAllowed(path.resolve(root.path), normalized, { includeHidden });
			return false;
		} catch {
			return true;
		}
	}

	private async loadRoots(): Promise<RootRecord[]> {
		if (this.rootCache) return this.rootCache;
		const configured = this.resolveConfiguredRootPaths();
		const roots: RootRecord[] = [];
		for (const rootPath of configured) {
			const absolutePath = path.resolve(rootPath);
			if (!existsSync(absolutePath)) continue;
			const rootRealPath = await realpath(absolutePath);
			roots.push({
				id: `root-${roots.length + 1}`,
				path: rootRealPath,
				realPath: rootRealPath,
				label: path.basename(rootRealPath) || rootRealPath,
			});
		}
		if (roots.length === 0) {
			throwFileSatelliteError({
				code: "FS_ROOTS_MISSING",
				message: "No allowed filesystem roots are available.",
				details: configured,
			});
		}
		this.rootCache = roots;
		return roots;
	}

	private resolveConfiguredRootPaths(): string[] {
		const configured = this.env.ELIZA_FS_ROOTS?.trim();
		if (configured) {
			return configured
				.split(",")
				.map((entry) => entry.trim())
				.filter((entry) => entry.length > 0);
		}
		const fallback =
			this.env.MILADY_REPO_DIR?.trim() ??
			this.env.ELIZA_REPO_DIR?.trim() ??
			process.cwd();
		return [fallback];
	}

	private selectRoot(
		roots: RootRecord[],
		options: ResolvePathOptions,
	): RootRecord {
		if (options.rootId) {
			const root = roots.find((candidate) => candidate.id === options.rootId);
			if (!root) {
				throwFileSatelliteError({
					code: "FS_PATH_DENIED",
					message: "Requested filesystem root is not allowed.",
					details: { rootId: options.rootId },
				});
			}
			return root;
		}

		if (options.path && path.isAbsolute(options.path)) {
			const absolutePath = path.resolve(options.path);
			const root = roots.find((candidate) =>
				isInsideRoot(candidate.realPath, absolutePath),
			);
			if (root) return root;
		}

		return roots[0];
	}

	private async resolveExisting(absolutePath: string): Promise<{
		realPath: string;
		exists: true;
	}> {
		try {
			await lstat(absolutePath);
			return { realPath: await realpath(absolutePath), exists: true };
		} catch {
			throwFileSatelliteError({
				code: "FS_PATH_NOT_FOUND",
				message: "Path does not exist.",
				path: absolutePath,
			});
		}
	}

	private async resolvePossiblyMissing(absolutePath: string): Promise<{
		realPath: string;
		exists: boolean;
	}> {
		if (existsSync(absolutePath)) {
			return { realPath: await realpath(absolutePath), exists: true };
		}

		const missingSegments: string[] = [];
		let cursor = absolutePath;
		while (!existsSync(cursor)) {
			const parent = path.dirname(cursor);
			if (parent === cursor) {
				throwFileSatelliteError({
					code: "FS_PATH_NOT_FOUND",
					message: "No existing parent directory was found.",
					path: absolutePath,
				});
			}
			missingSegments.unshift(path.basename(cursor));
			cursor = parent;
		}

		const parentRealPath = await realpath(cursor);
		return {
			realPath: path.resolve(parentRealPath, ...missingSegments),
			exists: false,
		};
	}

	private assertAllowed(
		rootPath: string,
		candidatePath: string,
		options: { includeHidden: boolean },
	): void {
		const relative = path.relative(rootPath, candidatePath);
		const segments = relative.split(path.sep).filter((segment) => segment.length > 0);
		for (let index = 0; index < segments.length; index += 1) {
			const segment = segments[index];
			if (SENSITIVE_NAMES.has(segment)) {
				throwFileSatelliteError({
					code: "FS_PATH_DENIED",
					message: "Sensitive filesystem path is denied.",
					path: candidatePath,
				});
			}
			if (segment === ".config" && segments[index + 1] === "gh") {
				throwFileSatelliteError({
					code: "FS_PATH_DENIED",
					message: "Sensitive filesystem path is denied.",
					path: candidatePath,
				});
			}
			if (GENERATED_NAMES.has(segment)) {
				throwFileSatelliteError({
					code: "FS_PATH_DENIED",
					message: "Generated filesystem path is excluded.",
					path: candidatePath,
				});
			}
			if (!options.includeHidden && segment.startsWith(".")) {
				throwFileSatelliteError({
					code: "FS_PATH_DENIED",
					message: "Hidden filesystem path is denied.",
					path: candidatePath,
				});
			}
		}
	}
}

function isInsideRoot(rootPath: string, candidatePath: string): boolean {
	const relative = path.relative(rootPath, candidatePath);
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	);
}
