/**
 * Skill Storage Abstraction
 *
 * Provides two storage backends:
 * - MemorySkillStore: For browser/virtual FS environments (skills in memory)
 * - FileSystemSkillStore: For Node.js/native environments (skills on disk)
 *
 * Both implement the same interface for seamless switching.
 */

import { parseFrontmatter, validateFrontmatter } from "./parser";
import type { Skill } from "./types";

type FflateUnzipped = Record<string, Uint8Array>;
interface FflateModule {
	unzipSync: (data: Uint8Array) => FflateUnzipped;
}

// fflate's package.json exports map omits a "types" entry in older transitive
// resolutions (v0.6.10 pulled in by three-stdlib), which breaks tsup's DTS
// build under bun's isolated layout. Widening moduleId to `string` prevents
// TypeScript from evaluating the import as a literal and triggering TS7016.
async function loadFflate(): Promise<FflateModule> {
	const moduleId: string = "fflate";
	return (await import(moduleId)) as FflateModule;
}

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
		// No-op for memory storage
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
		this.skills.set(pkg.slug, pkg);
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
		const { unzipSync } = await loadFflate();
		const unzipped = unzipSync(zipBuffer);

		const files = new Map<string, SkillFile>();

		for (const [fileName, data] of Object.entries(unzipped)) {
			if (fileName.endsWith("/")) continue;

			// Sanitize path
			const parts = fileName
				.split("/")
				.filter((p) => p && p !== ".." && p !== ".");
			if (parts.length === 0) continue;

			const relativePath = parts.join("/");
			const isText = isTextFile(relativePath);

			files.set(relativePath, {
				path: relativePath,
				content: isText ? new TextDecoder().decode(data) : data,
				isText,
			});
		}

		await this.saveSkill({ slug, files });
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
		const entries = fs.readdirSync(this.basePath, {
			withFileTypes: true,
		});
		return entries
			.filter((e) => e.isDirectory() && !e.name.startsWith("."))
			.filter((e) =>
				fs.existsSync(path.join(this.basePath, e.name, "SKILL.md")),
			)
			.map((e) => e.name);
	}

	async hasSkill(slug: string): Promise<boolean> {
		if (!this.fs || !this.path) await this.initialize();
		const { fs, path } = this.requireNodeModules();
		const skillPath = path.join(this.basePath, slug, "SKILL.md");
		return fs.existsSync(skillPath);
	}

	async loadSkillContent(slug: string): Promise<string | null> {
		if (!this.fs || !this.path) await this.initialize();
		const { fs, path } = this.requireNodeModules();
		const skillPath = path.join(this.basePath, slug, "SKILL.md");
		if (!fs.existsSync(skillPath)) return null;

		return fs.readFileSync(skillPath, "utf-8");
	}

	async loadFile(
		slug: string,
		relativePath: string,
	): Promise<string | Uint8Array | null> {
		if (!this.fs || !this.path) await this.initialize();
		const { fs, path } = this.requireNodeModules();

		// Sanitize path to prevent directory traversal
		const safePath = path.basename(relativePath);
		const subdir = path.dirname(relativePath);
		const fullPath = path.join(this.basePath, slug, subdir, safePath);

		if (!fs.existsSync(fullPath)) return null;

		if (isTextFile(relativePath)) {
			return fs.readFileSync(fullPath, "utf-8");
		} else {
			return new Uint8Array(fs.readFileSync(fullPath));
		}
	}

	async listFiles(slug: string, subdir?: string): Promise<string[]> {
		if (!this.fs || !this.path) await this.initialize();
		const { fs, path } = this.requireNodeModules();

		const dirPath = subdir
			? path.join(this.basePath, slug, subdir)
			: path.join(this.basePath, slug);

		if (!fs.existsSync(dirPath)) return [];

		return fs.readdirSync(dirPath).filter((f) => !f.startsWith("."));
	}

	async saveSkill(pkg: SkillPackage): Promise<void> {
		if (!this.fs || !this.path) await this.initialize();
		const { fs, path } = this.requireNodeModules();

		const skillDir = path.join(this.basePath, pkg.slug);

		// Create skill directory
		if (!fs.existsSync(skillDir)) {
			fs.mkdirSync(skillDir, { recursive: true });
		}

		// Write all files
		for (const [relativePath, file] of pkg.files) {
			const fullPath = path.join(skillDir, relativePath);
			const dir = path.dirname(fullPath);

			// Ensure directory exists
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}

			// Write file
			if (file.isText) {
				fs.writeFileSync(fullPath, file.content as string, "utf-8");
			} else {
				fs.writeFileSync(fullPath, file.content as Uint8Array);
			}
		}
	}

	async deleteSkill(slug: string): Promise<boolean> {
		if (!this.fs || !this.path) await this.initialize();
		const { fs, path } = this.requireNodeModules();
		const skillDir = path.join(this.basePath, slug);
		if (!fs.existsSync(skillDir)) return false;

		// Recursive delete
		fs.rmSync(skillDir, { recursive: true, force: true });
		return true;
	}

	getSkillPath(slug: string): string {
		return this.path
			? this.path.resolve(this.basePath, slug)
			: `${this.basePath}/${slug}`;
	}

	/**
	 * Save a skill from a zip buffer.
	 */
	async saveFromZip(slug: string, zipBuffer: Uint8Array): Promise<void> {
		const { unzipSync } = await loadFflate();
		const unzipped = unzipSync(zipBuffer);

		const files = new Map<string, SkillFile>();

		for (const [fileName, data] of Object.entries(unzipped)) {
			if (fileName.endsWith("/")) continue;

			const parts = fileName
				.split("/")
				.filter((p) => p && p !== ".." && p !== ".");
			if (parts.length === 0) continue;

			const relativePath = parts.join("/");
			const isText = isTextFile(relativePath);

			files.set(relativePath, {
				path: relativePath,
				content: isText ? new TextDecoder().decode(data) : data,
				isText,
			});
		}

		await this.saveSkill({ slug, files });
	}
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

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
