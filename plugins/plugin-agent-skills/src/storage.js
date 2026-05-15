/**
 * Skill Storage Abstraction
 *
 * Provides two storage backends:
 * - MemorySkillStore: For browser/virtual FS environments (skills in memory)
 * - FileSystemSkillStore: For Node.js/native environments (skills on disk)
 *
 * Both implement the same interface for seamless switching.
 */
var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { parseFrontmatter, validateFrontmatter } from "./parser";
// fflate's package.json exports map omits a "types" entry in older transitive
// resolutions (v0.6.10 pulled in by three-stdlib), which breaks tsup's DTS
// build under bun's isolated layout. Widening moduleId to `string` prevents
// TypeScript from evaluating the import as a literal and triggering TS7016.
async function loadFflate() {
    const moduleId = "fflate";
    return (await import(__rewriteRelativeImportExtension(moduleId)));
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
export class MemorySkillStore {
    type = "memory";
    skills = new Map();
    basePath;
    constructor(basePath = "/virtual/skills") {
        this.basePath = basePath;
    }
    async initialize() {
        // No-op for memory storage
    }
    async listSkills() {
        return Array.from(this.skills.keys());
    }
    async hasSkill(slug) {
        return this.skills.has(slug);
    }
    async loadSkillContent(slug) {
        const pkg = this.skills.get(slug);
        if (!pkg)
            return null;
        const skillMd = pkg.files.get("SKILL.md");
        if (!skillMd?.isText)
            return null;
        return skillMd.content;
    }
    async loadFile(slug, relativePath) {
        const pkg = this.skills.get(slug);
        if (!pkg)
            return null;
        const file = pkg.files.get(relativePath);
        if (!file)
            return null;
        return file.content;
    }
    async listFiles(slug, subdir) {
        const pkg = this.skills.get(slug);
        if (!pkg)
            return [];
        const prefix = subdir ? `${subdir}/` : "";
        const files = [];
        for (const [path] of pkg.files) {
            if (subdir) {
                if (path.startsWith(prefix) &&
                    !path.slice(prefix.length).includes("/")) {
                    files.push(path.slice(prefix.length));
                }
            }
            else if (!path.includes("/")) {
                files.push(path);
            }
        }
        return files;
    }
    async saveSkill(pkg) {
        this.skills.set(pkg.slug, pkg);
    }
    async deleteSkill(slug) {
        return this.skills.delete(slug);
    }
    getSkillPath(slug) {
        return `${this.basePath}/${slug}`;
    }
    /**
     * Load a skill directly from content (no network/file needed).
     */
    async loadFromContent(slug, skillMdContent, additionalFiles) {
        const files = new Map();
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
    async loadFromZip(slug, zipBuffer) {
        const { unzipSync } = await loadFflate();
        const unzipped = unzipSync(zipBuffer);
        const files = new Map();
        for (const [fileName, data] of Object.entries(unzipped)) {
            if (fileName.endsWith("/"))
                continue;
            // Sanitize path
            const parts = fileName
                .split("/")
                .filter((p) => p && p !== ".." && p !== ".");
            if (parts.length === 0)
                continue;
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
    getPackage(slug) {
        return this.skills.get(slug);
    }
    /**
     * Save a skill package from simple file list format.
     * Convenience method for use with GitHub/URL installs.
     */
    async savePackage(pkg) {
        const files = new Map();
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
    getAllPackages() {
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
export class FileSystemSkillStore {
    type = "filesystem";
    basePath;
    fs = null;
    path = null;
    requireNodeModules() {
        if (!this.fs || !this.path) {
            throw new Error("FileSystemSkillStore requires Node.js fs module");
        }
        return { fs: this.fs, path: this.path };
    }
    constructor(basePath = "./skills") {
        this.basePath = basePath;
    }
    async initialize() {
        // Dynamic imports for Node.js
        try {
            this.fs = await import("node:fs");
            this.path = await import("node:path");
            // Ensure base directory exists
            if (!this.fs.existsSync(this.basePath)) {
                this.fs.mkdirSync(this.basePath, { recursive: true });
            }
        }
        catch {
            throw new Error("FileSystemSkillStore requires Node.js fs module");
        }
    }
    async listSkills() {
        if (!this.fs || !this.path)
            await this.initialize();
        const { fs, path } = this.requireNodeModules();
        const entries = fs.readdirSync(this.basePath, {
            withFileTypes: true,
        });
        return entries
            .filter((e) => e.isDirectory() && !e.name.startsWith("."))
            .filter((e) => fs.existsSync(path.join(this.basePath, e.name, "SKILL.md")))
            .map((e) => e.name);
    }
    async hasSkill(slug) {
        if (!this.fs || !this.path)
            await this.initialize();
        const { fs, path } = this.requireNodeModules();
        const skillPath = path.join(this.basePath, slug, "SKILL.md");
        return fs.existsSync(skillPath);
    }
    async loadSkillContent(slug) {
        if (!this.fs || !this.path)
            await this.initialize();
        const { fs, path } = this.requireNodeModules();
        const skillPath = path.join(this.basePath, slug, "SKILL.md");
        if (!fs.existsSync(skillPath))
            return null;
        return fs.readFileSync(skillPath, "utf-8");
    }
    async loadFile(slug, relativePath) {
        if (!this.fs || !this.path)
            await this.initialize();
        const { fs, path } = this.requireNodeModules();
        // Sanitize path to prevent directory traversal
        const safePath = path.basename(relativePath);
        const subdir = path.dirname(relativePath);
        const fullPath = path.join(this.basePath, slug, subdir, safePath);
        if (!fs.existsSync(fullPath))
            return null;
        if (isTextFile(relativePath)) {
            return fs.readFileSync(fullPath, "utf-8");
        }
        else {
            return new Uint8Array(fs.readFileSync(fullPath));
        }
    }
    async listFiles(slug, subdir) {
        if (!this.fs || !this.path)
            await this.initialize();
        const { fs, path } = this.requireNodeModules();
        const dirPath = subdir
            ? path.join(this.basePath, slug, subdir)
            : path.join(this.basePath, slug);
        if (!fs.existsSync(dirPath))
            return [];
        return fs.readdirSync(dirPath).filter((f) => !f.startsWith("."));
    }
    async saveSkill(pkg) {
        if (!this.fs || !this.path)
            await this.initialize();
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
                fs.writeFileSync(fullPath, file.content, "utf-8");
            }
            else {
                fs.writeFileSync(fullPath, file.content);
            }
        }
    }
    async deleteSkill(slug) {
        if (!this.fs || !this.path)
            await this.initialize();
        const { fs, path } = this.requireNodeModules();
        const skillDir = path.join(this.basePath, slug);
        if (!fs.existsSync(skillDir))
            return false;
        // Recursive delete
        fs.rmSync(skillDir, { recursive: true, force: true });
        return true;
    }
    getSkillPath(slug) {
        return this.path
            ? this.path.resolve(this.basePath, slug)
            : `${this.basePath}/${slug}`;
    }
    /**
     * Save a skill from a zip buffer.
     */
    async saveFromZip(slug, zipBuffer) {
        const { unzipSync } = await loadFflate();
        const unzipped = unzipSync(zipBuffer);
        const files = new Map();
        for (const [fileName, data] of Object.entries(unzipped)) {
            if (fileName.endsWith("/"))
                continue;
            const parts = fileName
                .split("/")
                .filter((p) => p && p !== ".." && p !== ".");
            if (parts.length === 0)
                continue;
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
function isTextFile(filePath) {
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
export function createStorage(options) {
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
export async function loadSkillFromStorage(storage, slug, options = {}) {
    const content = await storage.loadSkillContent(slug);
    if (!content)
        return null;
    const { frontmatter } = parseFrontmatter(content);
    if (!frontmatter)
        return null;
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
//# sourceMappingURL=storage.js.map