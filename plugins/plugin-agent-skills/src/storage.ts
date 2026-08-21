/**
 * Skill Storage Abstraction
 *
 * Provides two storage backends:
 * - MemorySkillStore: For browser/virtual FS environments (skills in memory)
 * - FileSystemSkillStore: For Node.js/native environments (skills on disk)
 *
 * Both implement the same interface for seamless switching.
 *
 * Zip packages are untrusted input (registry downloads). Extraction rejects
 * entries with backslashes, absolute paths, `..` segments, or names Windows
 * would canonicalize at write time (trailing dots/spaces per component,
 * colons, reserved device names), refuses archives whose central directory
 * declares an uncompressed total over MAX_ZIP_UNCOMPRESSED_SIZE, and asserts
 * every filesystem write and delete resolves inside the target skill
 * directory.
 */

import { ElizaError, logger } from "@elizaos/core";
import { unzipSync } from "fflate";
import { parseFrontmatter, validateFrontmatter } from "./parser";
import type { Skill } from "./types";

/**
 * Maximum total uncompressed size of a skill zip (100 MB). The download cap in
 * services/skills.ts bounds only the compressed bytes; this bound stops
 * zip-bomb expansion before any entry is materialized. fflate's `unzipSync`
 * allocates exactly the per-entry uncompressed size declared in the central
 * directory, so summing those declared sizes is a hard memory bound.
 */
export const MAX_ZIP_UNCOMPRESSED_SIZE = 100 * 1024 * 1024;

// ============================================================
// STORAGE INTERFACE
// ============================================================

/**
 * Skill file representation for in-memory storage.
 */
export interface SkillFile {
	path: string;
	content: string | Uint8Array;
	isText: boolean;
}

/**
 * Skill package - all files for a skill.
 */
export interface SkillPackage {
	slug: string;
	files: Map<string, SkillFile>;
}

/** A staged replacement whose prior value remains available until finalization. */
export interface PreparedSkillReplacement {
	readonly slug: string;
	/** Make the staged package authoritative without deleting the prior package. */
	publish(): void;
	/** Restore the prior package, or discard an unpublished stage. */
	rollback(): void;
	/** Delete retained staging/backup state after the service commits all state. */
	finalize(): void;
}

/** A staged removal whose package remains recoverable until finalization. */
export interface PreparedSkillRemoval {
	readonly slug: string;
	readonly existed: boolean;
	publish(): void;
	rollback(): void;
	finalize(): void;
}

/**
 * Storage interface for skill management.
 */
export interface ISkillStorage {
	/** Storage type identifier */
	readonly type: "memory" | "filesystem";

	/** Initialize storage */
	initialize(): Promise<void>;

	/** List all installed skill slugs */
	listSkills(): Promise<string[]>;

	/** Check if a skill exists */
	hasSkill(slug: string): Promise<boolean>;

	/** Load a skill's SKILL.md content */
	loadSkillContent(slug: string): Promise<string | null>;

	/** Load a specific file from a skill */
	loadFile(
		slug: string,
		relativePath: string,
	): Promise<string | Uint8Array | null>;

	/** List files in a skill directory */
	listFiles(slug: string, subdir?: string): Promise<string[]>;

	/** Save a complete skill package */
	saveSkill(pkg: SkillPackage): Promise<void>;

	/** Stage a replacement without exposing it to readers. */
	prepareReplacement?(
		pkg: SkillPackage,
		options?: { signal?: AbortSignal },
	): Promise<PreparedSkillReplacement>;

	/** Stage removal without destroying the package needed for rollback. */
	prepareRemoval?(
		slug: string,
		options?: { signal?: AbortSignal },
	): Promise<PreparedSkillRemoval>;

	/** Delete a skill */
	deleteSkill(slug: string): Promise<boolean>;

	/** Get skill directory path (filesystem) or virtual path (memory) */
	getSkillPath(slug: string): string;
}

// ============================================================
// MEMORY STORAGE (Browser/Virtual FS)
// ============================================================

/**
 * In-memory skill storage for browser environments.
 *
 * Skills are stored entirely in memory, making this suitable for:
 * - Browser environments without filesystem access
 * - Virtual FS scenarios
 * - Testing
 * - Ephemeral skill loading
 */
export class MemorySkillStore implements ISkillStorage {
	readonly type = "memory" as const;

	private skills: Map<string, SkillPackage> = new Map();
	private basePath: string;

	constructor(basePath = "/virtual/skills") {
		this.basePath = basePath;
	}

	async initialize(): Promise<void> {
		// Memory storage is ready immediately.
	}

	async listSkills(): Promise<string[]> {
		return Array.from(this.skills.keys());
	}

	async hasSkill(slug: string): Promise<boolean> {
		return this.skills.has(slug);
	}

	async loadSkillContent(slug: string): Promise<string | null> {
		const pkg = this.skills.get(slug);
		if (!pkg) return null;

		const skillMd = pkg.files.get("SKILL.md");
		if (!skillMd?.isText) return null;

		return skillMd.content as string;
	}

	async loadFile(
		slug: string,
		relativePath: string,
	): Promise<string | Uint8Array | null> {
		const pkg = this.skills.get(slug);
		if (!pkg) return null;

		const file = pkg.files.get(relativePath);
		if (!file) return null;

		return file.content;
	}

	async listFiles(slug: string, subdir?: string): Promise<string[]> {
		const pkg = this.skills.get(slug);
		if (!pkg) return [];

		const prefix = subdir ? `${subdir}/` : "";
		const files: string[] = [];

		for (const [path] of pkg.files) {
			if (subdir) {
				if (
					path.startsWith(prefix) &&
					!path.slice(prefix.length).includes("/")
				) {
					files.push(path.slice(prefix.length));
				}
			} else if (!path.includes("/")) {
				files.push(path);
			}
		}

		return files;
	}

	async saveSkill(pkg: SkillPackage): Promise<void> {
		this.skills.set(pkg.slug, cloneSkillPackage(pkg));
	}

	async prepareReplacement(
		pkg: SkillPackage,
		options: { signal?: AbortSignal } = {},
	): Promise<PreparedSkillReplacement> {
		options.signal?.throwIfAborted();
		const candidate = cloneSkillPackage(pkg);
		const previous = this.skills.get(pkg.slug);
		const previousSnapshot = previous ? cloneSkillPackage(previous) : null;
		let published = false;
		let finished = false;
		return {
			slug: pkg.slug,
			publish: () => {
				if (finished) throw new Error("Skill replacement is already finalized");
				options.signal?.throwIfAborted();
				this.skills.set(pkg.slug, cloneSkillPackage(candidate));
				published = true;
			},
			rollback: () => {
				if (finished) return;
				if (published) {
					if (previousSnapshot) {
						this.skills.set(pkg.slug, cloneSkillPackage(previousSnapshot));
					} else {
						this.skills.delete(pkg.slug);
					}
				}
				finished = true;
			},
			finalize: () => {
				finished = true;
			},
		};
	}

	async prepareRemoval(
		slug: string,
		options: { signal?: AbortSignal } = {},
	): Promise<PreparedSkillRemoval> {
		options.signal?.throwIfAborted();
		const previous = this.skills.get(slug);
		const previousSnapshot = previous ? cloneSkillPackage(previous) : null;
		let published = false;
		let finished = false;
		return {
			slug,
			existed: previousSnapshot !== null,
			publish: () => {
				if (finished) throw new Error("Skill removal is already finalized");
				options.signal?.throwIfAborted();
				if (previousSnapshot) this.skills.delete(slug);
				published = true;
			},
			rollback: () => {
				if (finished) return;
				if (published && previousSnapshot) {
					this.skills.set(slug, cloneSkillPackage(previousSnapshot));
				}
				finished = true;
			},
			finalize: () => {
				finished = true;
			},
		};
	}

	async deleteSkill(slug: string): Promise<boolean> {
		return this.skills.delete(slug);
	}

	getSkillPath(slug: string): string {
		return `${this.basePath}/${slug}`;
	}

	/**
	 * Load a skill directly from content (no network/file needed).
	 */
	async loadFromContent(
		slug: string,
		skillMdContent: string,
		additionalFiles?: Map<string, string | Uint8Array>,
	): Promise<void> {
		const files = new Map<string, SkillFile>();

		// Add SKILL.md
		files.set("SKILL.md", {
			path: "SKILL.md",
			content: skillMdContent,
			isText: true,
		});

		// Add any additional files
		if (additionalFiles) {
			for (const [path, content] of additionalFiles) {
				files.set(path, {
					path,
					content,
					isText: typeof content === "string",
				});
			}
		}

		await this.saveSkill({ slug, files });
	}

	/**
	 * Load a skill from a zip buffer (for registry downloads).
	 */
	async loadFromZip(slug: string, zipBuffer: Uint8Array): Promise<void> {
		await this.saveSkill(createSkillPackageFromZip(slug, zipBuffer));
	}

	/**
	 * Get the full skill package (for export/transfer).
	 */
	getPackage(slug: string): SkillPackage | undefined {
		return this.skills.get(slug);
	}

	/**
	 * Save a skill package from simple file list format.
	 * Convenience method for use with GitHub/URL installs.
	 */
	async savePackage(pkg: {
		slug: string;
		files: Array<{ name: string; content: string | Uint8Array }>;
		loadedAt?: number;
	}): Promise<void> {
		const files = new Map<string, SkillFile>();

		for (const file of pkg.files) {
			const isText = typeof file.content === "string";
			files.set(file.name, {
				path: file.name,
				content: file.content,
				isText,
			});
		}

		await this.saveSkill({ slug: pkg.slug, files });
	}

	/**
	 * Get all skills in memory.
	 */
	getAllPackages(): Map<string, SkillPackage> {
		return new Map(this.skills);
	}
}

// ============================================================
// FILESYSTEM STORAGE (Node.js/Native)
// ============================================================

/**
 * Filesystem-based skill storage for Node.js environments.
 *
 * Skills are stored on disk, making this suitable for:
 * - Node.js server environments
 * - CLI tools
 * - Persistent skill installations
 */
export class FileSystemSkillStore implements ISkillStorage {
	readonly type = "filesystem" as const;

	readonly basePath: string;
	private fs: typeof import("fs") | null = null;
	private path: typeof import("path") | null = null;

	private requireNodeModules(): {
		fs: typeof import("fs");
		path: typeof import("path");
	} {
		if (!this.fs || !this.path) {
			throw new Error("FileSystemSkillStore requires Node.js fs module");
		}
		return { fs: this.fs, path: this.path };
	}

	constructor(basePath = "./skills") {
		this.basePath = basePath;
	}

	async initialize(): Promise<void> {
		// Dynamic imports for Node.js
		try {
			this.fs = await import("node:fs");
			this.path = await import("node:path");

			// Ensure base directory exists
			if (!this.fs.existsSync(this.basePath)) {
				this.fs.mkdirSync(this.basePath, { recursive: true });
			}
		} catch {
			throw new Error("FileSystemSkillStore requires Node.js fs module");
		}
	}

	async listSkills(): Promise<string[]> {
		if (!this.fs || !this.path) await this.initialize();
		const { fs, path } = this.requireNodeModules();
		const resolvedBase = path.resolve(this.basePath);
		const entries = fs.readdirSync(this.basePath, {
			withFileTypes: true,
		});
		const slugs: string[] = [];
		for (const entry of entries) {
			if (
				!entry.isDirectory() ||
				entry.name.startsWith(".") ||
				!isPortableSkillStorageSlug(entry.name)
			) {
				continue;
			}
			const skillDir = resolveSkillDirectory(path, resolvedBase, entry.name);
			const skillPath = path.join(skillDir, "SKILL.md");
			if (!fs.existsSync(skillPath)) continue;
			try {
				assertSkillTargetRealPathContained(
					fs,
					path,
					resolvedBase,
					skillDir,
					skillPath,
					entry.name,
				);
			} catch (error) {
				// error-policy:J3 A stored entry that crosses its skill boundary is
				// explicitly invalid and omitted; unrelated valid skills remain usable.
				if (error instanceof ElizaError && error.code === "SKILL_PATH_TRAVERSAL") {
					continue;
				}
				throw error;
			}
			slugs.push(entry.name);
		}
		return slugs;
	}

	async hasSkill(slug: string): Promise<boolean> {
		if (!this.fs || !this.path) await this.initialize();
		const { fs, path } = this.requireNodeModules();
		const resolvedBase = path.resolve(this.basePath);
		const skillDir = resolveSkillDirectory(path, resolvedBase, slug);
		const skillPath = resolveContainedPath(
			path,
			skillDir,
			path.join(skillDir, "SKILL.md"),
			"SKILL.md",
		);
		assertSkillTargetRealPathContained(
			fs,
			path,
			resolvedBase,
			skillDir,
			skillPath,
			slug,
		);
		return fs.existsSync(skillPath);
	}

	async loadSkillContent(slug: string): Promise<string | null> {
		if (!this.fs || !this.path) await this.initialize();
		const { fs, path } = this.requireNodeModules();
		const resolvedBase = path.resolve(this.basePath);
		const skillDir = resolveSkillDirectory(path, resolvedBase, slug);
		const skillPath = resolveContainedPath(
			path,
			skillDir,
			path.join(skillDir, "SKILL.md"),
			"SKILL.md",
		);
		if (!fs.existsSync(skillPath)) return null;
		assertSkillTargetRealPathContained(
			fs,
			path,
			resolvedBase,
			skillDir,
			skillPath,
			slug,
		);

		return fs.readFileSync(skillPath, "utf-8");
	}

	async loadFile(
		slug: string,
		relativePath: string,
	): Promise<string | Uint8Array | null> {
		if (!this.fs || !this.path) await this.initialize();
		const { fs, path } = this.requireNodeModules();

		const resolvedBase = path.resolve(this.basePath);
		const skillDir = resolveSkillDirectory(path, resolvedBase, slug);
		const fullPath = resolveContainedPath(
			path,
			skillDir,
			path.join(skillDir, relativePath),
			relativePath,
		);

		if (!fs.existsSync(fullPath)) return null;
		assertSkillTargetRealPathContained(
			fs,
			path,
			resolvedBase,
			skillDir,
			fullPath,
			relativePath,
		);

		if (isTextFile(relativePath)) {
			return fs.readFileSync(fullPath, "utf-8");
		} else {
			return new Uint8Array(fs.readFileSync(fullPath));
		}
	}

	async listFiles(slug: string, subdir?: string): Promise<string[]> {
		if (!this.fs || !this.path) await this.initialize();
		const { fs, path } = this.requireNodeModules();

		const resolvedBase = path.resolve(this.basePath);
		const skillDir = resolveSkillDirectory(path, resolvedBase, slug);
		const dirPath = subdir
			? resolveContainedPath(
					path,
					skillDir,
					path.join(skillDir, subdir),
					subdir,
				)
			: skillDir;

		if (!fs.existsSync(dirPath)) return [];
		assertSkillTargetRealPathContained(
			fs,
			path,
			resolvedBase,
			skillDir,
			dirPath,
			subdir ?? slug,
		);

		return fs.readdirSync(dirPath).filter((f) => !f.startsWith("."));
	}

	async saveSkill(pkg: SkillPackage): Promise<void> {
		const replacement = await this.prepareReplacement(pkg);
		try {
			replacement.publish();
			replacement.finalize();
		} catch (cause) {
			replacement.rollback();
			throw cause;
		}
	}

	async prepareReplacement(
		pkg: SkillPackage,
		options: { signal?: AbortSignal } = {},
	): Promise<PreparedSkillReplacement> {
		if (!this.fs || !this.path) await this.initialize();
		options.signal?.throwIfAborted();
		const { fs, path } = this.requireNodeModules();
		const resolvedBase = path.resolve(this.basePath);
		const skillDir = resolveSkillDirectory(path, resolvedBase, pkg.slug);
		const validatedFiles = [...pkg.files].map(([relativePath, file]) => ({
			file,
			relativePath: validateSkillPackagePath(path, skillDir, relativePath),
		}));
		if (fs.existsSync(skillDir)) {
			assertExistingRealPathContained(fs, path, resolvedBase, skillDir, pkg.slug);
		}

		const stagingDir = fs.mkdtempSync(path.join(resolvedBase, ".skill-install-"));
		const backupDir = `${stagingDir}.previous`;
		let movedExisting = false;
		let published = false;
		let finished = false;
		try {
			for (const { file, relativePath } of validatedFiles) {
				options.signal?.throwIfAborted();
				const fullPath = resolveContainedPath(
					path,
					stagingDir,
					path.join(stagingDir, relativePath),
					relativePath,
				);
				fs.mkdirSync(path.dirname(fullPath), { recursive: true });
				if (file.isText) {
					fs.writeFileSync(fullPath, file.content as string, "utf-8");
				} else {
					fs.writeFileSync(fullPath, file.content as Uint8Array);
				}
			}
			options.signal?.throwIfAborted();
		} catch (cause) {
			fs.rmSync(stagingDir, { recursive: true, force: true });
			throw cause;
		}

		const rollback = (): void => {
			if (finished) return;
			try {
				if (published && fs.existsSync(skillDir)) {
					fs.rmSync(skillDir, { recursive: true, force: true });
				}
				if (movedExisting && fs.existsSync(backupDir)) {
					fs.renameSync(backupDir, skillDir);
				}
				if (fs.existsSync(stagingDir)) {
					fs.rmSync(stagingDir, { recursive: true, force: true });
				}
				finished = true;
			} catch (rollbackCause) {
				throw new ElizaError("Failed to restore skill replacement", {
					code: "SKILL_STORAGE_ROLLBACK_FAILED",
					context: { slug: pkg.slug },
					severity: "fatal",
					cause: rollbackCause,
				});
			}
		};

		return {
			slug: pkg.slug,
			publish: () => {
				if (finished) throw new Error("Skill replacement is already finalized");
				options.signal?.throwIfAborted();
				try {
					if (fs.existsSync(skillDir)) {
						fs.renameSync(skillDir, backupDir);
						movedExisting = true;
					}
					fs.renameSync(stagingDir, skillDir);
					published = true;
				} catch (cause) {
					rollback();
					throw cause;
				}
			},
			rollback,
			finalize: () => {
				if (finished) return;
				finished = true;
				try {
					if (movedExisting) {
						fs.rmSync(backupDir, { recursive: true, force: true });
					}
				} catch (cause) {
					// error-policy:J6 The committed replacement is authoritative; stale
					// backup cleanup is best-effort and never fabricates install failure.
					logger.warn(
						`[FileSystemSkillStore] Failed to remove replaced skill backup: ${cause instanceof Error ? cause.message : String(cause)}`,
					);
				}
			},
		};
	}

	async prepareRemoval(
		slug: string,
		options: { signal?: AbortSignal } = {},
	): Promise<PreparedSkillRemoval> {
		if (!this.fs || !this.path) await this.initialize();
		options.signal?.throwIfAborted();
		const { fs, path } = this.requireNodeModules();
		const resolvedBase = path.resolve(this.basePath);
		const skillDir = resolveSkillDirectory(path, resolvedBase, slug);
		const existed = fs.existsSync(skillDir);
		if (existed) {
			assertExistingRealPathContained(fs, path, resolvedBase, skillDir, slug);
		}
		const stagingDir = fs.mkdtempSync(path.join(resolvedBase, ".skill-remove-"));
		const retainedDir = path.join(stagingDir, "previous");
		let published = false;
		let finished = false;
		const rollback = (): void => {
			if (finished) return;
			try {
				if (published && fs.existsSync(retainedDir)) {
					fs.renameSync(retainedDir, skillDir);
				}
				fs.rmSync(stagingDir, { recursive: true, force: true });
				finished = true;
			} catch (cause) {
				throw new ElizaError("Failed to restore removed skill", {
					code: "SKILL_STORAGE_ROLLBACK_FAILED",
					context: { slug },
					severity: "fatal",
					cause,
				});
			}
		};
		return {
			slug,
			existed,
			publish: () => {
				if (finished) throw new Error("Skill removal is already finalized");
				options.signal?.throwIfAborted();
				if (existed) fs.renameSync(skillDir, retainedDir);
				published = true;
			},
			rollback,
			finalize: () => {
				if (finished) return;
				finished = true;
				try {
					fs.rmSync(stagingDir, { recursive: true, force: true });
				} catch (cause) {
					// error-policy:J6 Removal is committed; retained backup cleanup is best effort.
					logger.warn(
						`[FileSystemSkillStore] Failed to remove uninstalled skill backup: ${cause instanceof Error ? cause.message : String(cause)}`,
					);
				}
			},
		};
	}

	async deleteSkill(slug: string): Promise<boolean> {
		if (!this.fs || !this.path) await this.initialize();
		const { fs, path } = this.requireNodeModules();
		const resolvedBase = path.resolve(this.basePath);
		const skillDir = resolveSkillDirectory(path, resolvedBase, slug);
		if (!fs.existsSync(skillDir)) return false;
		assertExistingRealPathContained(fs, path, resolvedBase, skillDir, slug);

		// Recursive delete
		fs.rmSync(skillDir, { recursive: true, force: true });
		return true;
	}

	getSkillPath(slug: string): string {
		assertSkillStorageSlug(slug);
		if (!this.path) return `${this.basePath}/${slug}`;
		const resolvedBase = this.path.resolve(this.basePath);
		return resolveSkillDirectory(this.path, resolvedBase, slug);
	}

	/**
	 * Save a skill from a zip buffer.
	 */
	async saveFromZip(slug: string, zipBuffer: Uint8Array): Promise<void> {
		await this.saveSkill(createSkillPackageFromZip(slug, zipBuffer));
	}
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function cloneSkillPackage(pkg: SkillPackage): SkillPackage {
	const files = new Map<string, SkillFile>();
	for (const [relativePath, file] of pkg.files) {
		files.set(relativePath, {
			path: file.path,
			content:
				typeof file.content === "string"
					? file.content
					: new Uint8Array(file.content),
			isText: file.isText,
		});
	}
	return { slug: pkg.slug, files };
}

/** Build a detached package from authored files without publishing it. */
export function createSkillPackage(
	slug: string,
	files: Array<{ name: string; content: string | Uint8Array }>,
): SkillPackage {
	const packageFiles = new Map<string, SkillFile>();
	for (const file of files) {
		const relativePath = sanitizeZipEntryPath(file.name);
		if (relativePath === null) continue;
		packageFiles.set(relativePath, {
			path: relativePath,
			content:
				typeof file.content === "string"
					? file.content
					: new Uint8Array(file.content),
			isText: typeof file.content === "string",
		});
	}
	return { slug, files: packageFiles };
}

/** Decode an untrusted zip into a detached package without publishing it. */
export function createSkillPackageFromZip(
	slug: string,
	zipBuffer: Uint8Array,
): SkillPackage {
	assertZipUncompressedSizeWithinLimit(zipBuffer);
	const files: Array<{ name: string; content: string | Uint8Array }> = [];
	for (const [fileName, data] of Object.entries(unzipSync(zipBuffer))) {
		if (fileName.endsWith("/")) continue;
		const relativePath = sanitizeZipEntryPath(fileName);
		if (relativePath === null) continue;
		files.push({
			name: relativePath,
			content: isTextFile(relativePath)
				? new TextDecoder().decode(data)
				: data,
		});
	}
	return createSkillPackage(slug, files);
}

/**
 * Sum the uncompressed sizes declared in a zip's central directory and reject
 * archives over MAX_ZIP_UNCOMPRESSED_SIZE before any entry is decompressed.
 * `unzipSync` materializes every entry at its declared size, so the declared
 * total is the exact peak allocation. Malformed and zip64 archives are
 * rejected: a skill package under the 10 MB compressed cap never needs zip64.
 */
function assertZipUncompressedSizeWithinLimit(zipBuffer: Uint8Array): void {
	const data = zipBuffer;
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

	// Locate the End Of Central Directory record by scanning backwards through
	// the maximum comment window, mirroring fflate's own search bounds.
	let eocd = -1;
	const scanFloor = Math.max(0, data.length - 22 - 0xffff);
	for (let i = data.length - 22; i >= scanFloor; i--) {
		if (
			data[i] === 0x50 &&
			data[i + 1] === 0x4b &&
			data[i + 2] === 0x05 &&
			data[i + 3] === 0x06
		) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) {
		throw new ElizaError("Skill zip is not a valid archive", {
			code: "SKILL_ZIP_INVALID",
			context: { reason: "end of central directory not found" },
		});
	}

	const entryCount = view.getUint16(eocd + 10, true);
	const cdOffset = view.getUint32(eocd + 16, true);
	if (entryCount === 0xffff || cdOffset === 0xffffffff) {
		throw new ElizaError("Skill zip uses zip64, which skill packages do not support", {
			code: "SKILL_ZIP_INVALID",
			context: { reason: "zip64 central directory" },
		});
	}

	let totalUncompressed = 0;
	let offset = cdOffset;
	for (let i = 0; i < entryCount; i++) {
		if (offset + 46 > data.length || view.getUint32(offset, true) !== 0x02014b50) {
			throw new ElizaError("Skill zip is not a valid archive", {
				code: "SKILL_ZIP_INVALID",
				context: { reason: "malformed central directory entry", entryIndex: i },
			});
		}
		totalUncompressed += view.getUint32(offset + 24, true);
		if (totalUncompressed > MAX_ZIP_UNCOMPRESSED_SIZE) {
			throw new ElizaError("Skill zip expands beyond the uncompressed size limit", {
				code: "SKILL_ZIP_TOO_LARGE",
				context: {
					declaredBytes: totalUncompressed,
					maxBytes: MAX_ZIP_UNCOMPRESSED_SIZE,
				},
			});
		}
		const nameLen = view.getUint16(offset + 28, true);
		const extraLen = view.getUint16(offset + 30, true);
		const commentLen = view.getUint16(offset + 32, true);
		offset += 46 + nameLen + extraLen + commentLen;
	}
}

/**
 * Reserved Windows device name stems. Win32 resolves these as the stem of any
 * path component — with or without an extension (`NUL`, `nul.txt`) — to a
 * device rather than a regular file, so a skill entry using one would never
 * land where the validated relative path says it should.
 */
const WINDOWS_RESERVED_STEMS = new Set([
	"CON",
	"PRN",
	"AUX",
	"NUL",
	...Array.from({ length: 10 }, (_, i) => `COM${i}`),
	...Array.from({ length: 10 }, (_, i) => `LPT${i}`),
	"COM¹",
	"COM²",
	"COM³",
	"LPT¹",
	"LPT²",
	"LPT³",
]);

/**
 * Normalize a zip entry name to a safe relative path, or return null for
 * entries that carry no file (e.g. bare `.` segments). Throws on any entry
 * whose name could resolve to a different file than the one validated here:
 * backslashes (path separators on Windows, invisible to a `/`-split filter),
 * absolute paths, colons (drive designators and NTFS alternate-data-stream
 * separators), `..` segments, segments ending in a dot or space (Win32
 * strips those per component, so `.. ` becomes `..` and `...` collapses to
 * nothing at write time), and reserved Windows device names. Rejecting the
 * whole archive rather than silently filtering keeps a malicious package
 * from installing in a half-sanitized shape.
 */
function sanitizeZipEntryPath(fileName: string): string | null {
	if (
		fileName.includes("\\") ||
		fileName.startsWith("/") ||
		fileName.includes(":")
	) {
		throw new ElizaError("Skill zip entry has an unsafe path", {
			code: "SKILL_ZIP_ENTRY_UNSAFE",
			context: { entry: fileName },
		});
	}

	const kept: string[] = [];
	for (const part of fileName.split("/")) {
		// Conventional no-op segments (`a//b`, `a/./b`) stay silently skipped.
		if (part === "" || part === ".") continue;
		assertSafeZipEntrySegment(part, fileName);
		kept.push(part);
	}
	return kept.length === 0 ? null : kept.join("/");
}

/** Validate a direct storage package path against lexical and portable rules. */
function validateSkillPackagePath(
	path: typeof import("path"),
	resolvedSkillDir: string,
	relativePath: string,
): string {
	resolveContainedPath(
		path,
		resolvedSkillDir,
		path.join(resolvedSkillDir, relativePath),
		relativePath,
	);
	const normalized = sanitizeZipEntryPath(relativePath);
	if (normalized === null || normalized !== relativePath) {
		throw new ElizaError("Skill file has an unsafe path", {
			code: "SKILL_ZIP_ENTRY_UNSAFE",
			context: { entry: relativePath },
		});
	}
	return normalized;
}

/**
 * Validate one zip entry path segment against Windows canonicalization
 * tricks. Win32 strips trailing dots and spaces from every component before
 * writing, so `.. ` becomes a parent traversal, `...` collapses to nothing,
 * and `dir ` silently renames to `dir`; reserved stems resolve to devices
 * rather than files. Rejecting the whole class guarantees the name validated
 * here is the name the filesystem actually writes, on every platform.
 */
function assertSafeZipEntrySegment(segment: string, entryName: string): void {
	const reject = (reason: string): never => {
		throw new ElizaError("Skill zip entry has an unsafe path", {
			code: "SKILL_ZIP_ENTRY_UNSAFE",
			context: { entry: entryName, reason },
		});
	};

	if (segment === "..") {
		reject("parent traversal segment");
	}
	if (/[. ]$/.test(segment)) {
		reject("segment ends with a dot or space, which Windows strips");
	}
	const stem = segment.split(".", 1)[0].toUpperCase();
	if (WINDOWS_RESERVED_STEMS.has(stem)) {
		reject("reserved Windows device name");
	}
}

/**
 * Assert that a filesystem target resolves strictly inside a base directory.
 * `path.resolve` collapses both separators on Windows, so this is the
 * platform-correct backstop behind entry-name validation. Throws on equality
 * too: the base directory itself is never a valid write/delete target.
 */
function assertContainedPath(
	path: typeof import("path"),
	resolvedBase: string,
	target: string,
	label: string,
): void {
	const resolvedTarget = path.resolve(target);
	if (
		resolvedTarget === resolvedBase ||
		!resolvedTarget.startsWith(resolvedBase + path.sep)
	) {
		throwSkillPathTraversal(label);
	}
}

/** Resolve a target and return it only when it is strictly inside `base`. */
function resolveContainedPath(
	path: typeof import("path"),
	base: string,
	target: string,
	label: string,
): string {
	const resolvedBase = path.resolve(base);
	const resolvedTarget = path.resolve(resolvedBase, target);
	assertContainedPath(path, resolvedBase, resolvedTarget, label);
	return resolvedTarget;
}

/**
 * Keep the storage key to one portable directory component. Domain-level
 * skill-name validation is intentionally stricter and remains owned by the
 * service boundary; this lower-level guard prevents escape and cross-platform
 * aliases such as reserved Win32 device stems.
 */
function assertSkillStorageSlug(slug: string): void {
	if (!isPortableSkillStorageSlug(slug)) {
		throwSkillPathTraversal(slug);
	}
}

/** Whether a storage key names the same single directory on every platform. */
function isPortableSkillStorageSlug(slug: string): boolean {
	if (
		!slug ||
		slug === "." ||
		slug === ".." ||
		slug.includes("/") ||
		slug.includes("\\") ||
		slug.includes(":") ||
		slug.includes("\0") ||
		/[. ]$/.test(slug)
	) {
		return false;
	}
	const stem = slug.split(".", 1)[0].toUpperCase();
	return !WINDOWS_RESERVED_STEMS.has(stem);
}

/** Resolve a portable skill slug beneath the configured storage root. */
function resolveSkillDirectory(
	path: typeof import("path"),
	resolvedBase: string,
	slug: string,
): string {
	assertSkillStorageSlug(slug);
	return resolveContainedPath(path, resolvedBase, slug, slug);
}

/**
 * Reject an existing target whose real path escapes through a symlink. Lexical
 * containment alone is insufficient for public read/write helpers because an
 * otherwise safe child directory can be replaced with a link to arbitrary
 * host files. This rejects stored links at operation time; it cannot close the
 * check/use race against a same-host actor who can mutate the storage root, so
 * filesystem ownership remains the trust boundary for that stronger threat.
 */
function assertExistingRealPathContained(
	fs: typeof import("fs"),
	path: typeof import("path"),
	base: string,
	target: string,
	label: string,
): void {
	if (!fs.existsSync(target)) return;
	const realBase = fs.realpathSync(base);
	const realTarget = fs.realpathSync(target);
	if (realTarget !== realBase && !realTarget.startsWith(realBase + path.sep)) {
		throwSkillPathTraversal(label);
	}
}

/** Enforce both the storage-root boundary and the selected skill boundary. */
function assertSkillTargetRealPathContained(
	fs: typeof import("fs"),
	path: typeof import("path"),
	resolvedBase: string,
	skillDir: string,
	target: string,
	label: string,
): void {
	assertExistingRealPathContained(fs, path, resolvedBase, skillDir, label);
	assertExistingRealPathContained(fs, path, skillDir, target, label);
}

function throwSkillPathTraversal(label: string): never {
	throw new ElizaError("Skill path escapes the skill directory", {
		code: "SKILL_PATH_TRAVERSAL",
		context: { path: label },
	});
}

/**
 * Determine if a file is text-based by extension.
 */
function isTextFile(filePath: string): boolean {
	const textExtensions = new Set([
		".md",
		".txt",
		".json",
		".yaml",
		".yml",
		".toml",
		".js",
		".ts",
		".py",
		".rs",
		".sh",
		".bash",
		".html",
		".css",
		".xml",
		".svg",
		".env",
		".gitignore",
		".dockerignore",
	]);

	const ext = filePath.substring(filePath.lastIndexOf(".")).toLowerCase();
	return textExtensions.has(ext) || !filePath.includes(".");
}

/**
 * Create the appropriate storage based on environment.
 */
export function createStorage(options: {
	type?: "memory" | "filesystem" | "auto";
	basePath?: string;
}): ISkillStorage {
	const { type = "auto", basePath } = options;

	if (type === "memory") {
		return new MemorySkillStore(basePath);
	}

	if (type === "filesystem") {
		return new FileSystemSkillStore(basePath);
	}

	// Auto-detect: use memory in browser, filesystem in Node.js
	if (typeof window !== "undefined" || typeof process === "undefined") {
		return new MemorySkillStore(basePath);
	}

	return new FileSystemSkillStore(basePath);
}

// ============================================================
// SKILL LOADER (Works with any storage)
// ============================================================

/**
 * Load a skill from storage into a Skill object.
 */
export async function loadSkillFromStorage(
	storage: ISkillStorage,
	slug: string,
	options: { validate?: boolean } = {},
): Promise<Skill | null> {
	const content = await storage.loadSkillContent(slug);
	if (!content) return null;

	const { frontmatter } = parseFrontmatter(content);
	if (!frontmatter) return null;

	// Validate if requested
	if (options.validate !== false) {
		const result = validateFrontmatter(frontmatter, slug);
		if (!result.valid) {
			console.warn(`Skill ${slug} validation failed:`, result.errors);
		}
	}

	// List resource files
	const scripts = await storage.listFiles(slug, "scripts");
	const references = await storage.listFiles(slug, "references");
	const assets = await storage.listFiles(slug, "assets");

	return {
		slug,
		name: frontmatter.name,
		description: frontmatter.description,
		version: frontmatter.metadata?.version?.toString() || "local",
		content,
		frontmatter,
		path: storage.getSkillPath(slug),
		scripts,
		references,
		assets,
		loadedAt: Date.now(),
	};
}
