/**
 * Agent Skills Service
 *
 * Core service for discovering, loading, and managing Agent Skills.
 * Implements the Agent Skills specification with Otto compatibility.
 *
 * Supports two storage modes:
 * - Memory: For browser/virtual FS environments (skills loaded into memory)
 * - Filesystem: For Node.js/native environments (skills on disk)
 *
 * Skill source precedence (highest to lowest):
 * 1. workspace - Skills in workspace directory
 * 2. managed - Installed/downloaded skills
 * 3. bundled - Read-only bundled skills
 * 4. plugin - Plugin-contributed skills
 * 5. extra - Extra directories from config
 *
 * @see https://agentskills.io/specification
 */
import { Service } from "@elizaos/core";
import { estimateTokens, extractBody, generateSkillsJson, parseFrontmatter, validateFrontmatter, } from "../parser";
import { createStorage, FileSystemSkillStore, MemorySkillStore, } from "../storage";
import { SKILL_SOURCE_PRECEDENCE } from "../types";

// ============================================================
// CONSTANTS
// ============================================================
/** Default ClawHub API base URL */
const CLAWHUB_API = "https://clawhub.ai";
/** Cache TTL defaults (in milliseconds) */
const CACHE_TTL = {
    CATALOG: 1000 * 60 * 60, // 1 hour - list of all skills
    SKILL_DETAILS: 1000 * 60 * 30, // 30 min - individual skill details
    SEARCH: 1000 * 60 * 5, // 5 min - search results
};
/**
 * Cooldown period after a catalog fetch error before retrying (5 minutes).
 * Prevents hammering the API when it returns errors (e.g. 429 rate-limit).
 */
const FETCH_ERROR_COOLDOWN = 1000 * 60 * 5;
/** Maximum package size for downloads */
const MAX_PACKAGE_SIZE = 10 * 1024 * 1024; // 10MB
/** Default auto-refresh interval (5 seconds) */
const DEFAULT_AUTO_REFRESH_INTERVAL = 5000;
/** Eligibility cache TTL (5 minutes) */
const ELIGIBILITY_CACHE_TTL = 5 * 60 * 1000;
// ============================================================
// HELPER FUNCTIONS
// ============================================================
/**
 * Validate and sanitize a skill slug.
 */
function sanitizeSlug(slug) {
    const sanitized = slug.replace(/[^a-zA-Z0-9_-]/g, "");
    if (sanitized !== slug || sanitized.length === 0 || sanitized.length > 100) {
        throw new Error(`Invalid skill slug: ${slug}`);
    }
    return sanitized;
}
// ============================================================
// SERVICE
// ============================================================
// Note: LoadedSkill type is imported from ../types
/**
 * Agent Skills Service
 *
 * Manages skill discovery, loading, validation, and registry integration.
 * Works with both memory-based and filesystem-based storage.
 *
 * Supports two types of skill sources:
 * - **Managed skills**: Installed from registry, stored in skillsDir, modifiable
 * - **Bundled skills**: Read-only skills from bundledSkillsDirs, shipped with app
 */
export class AgentSkillsService extends Service {
    runtime;
    static serviceType = "AGENT_SKILLS_SERVICE";
    capabilityDescription = "Agent Skills - discover, load, and execute modular agent capabilities";
    storage;
    apiBase;
    syncCatalogOnStart;
    autoLoad;
    // Bundled skills configuration
    bundledSkillsDirs;
    bundledStorages = new Map();
    // Phase 4.1: Additional skill source directories
    workspaceSkillsDir = null;
    workspaceStorage = null;
    pluginSkillsDirs = [];
    pluginStorages = new Map();
    extraDirs = [];
    extraStorages = new Map();
    // In-memory caches - now tracks LoadedSkill with source info
    loadedSkills = new Map();
    catalogCache = null;
    searchCache = new Map();
    detailsCache = new Map();
    // Phase 4.2: Eligibility cache
    eligibilityCache = new Map();
    // Phase 4.4: Skill configuration
    allowlist = null;
    denylist = new Set();
    skillEntries = new Map();
    skillEnvOverrides = new Map();
    skillApiKeys = new Map();
    // Security scan status tracking
    // Maps skill slug -> scan status for skills that were scanned on install
    scanStatusMap = new Map();
    // Auto-refresh watcher
    autoRefreshEnabled = false;
    autoRefreshInterval = DEFAULT_AUTO_REFRESH_INTERVAL;
    watcherCleanup = null;
    // Catalog cache for disk persistence (filesystem mode only)
    catalogCachePath = null;
    lockfilePath = null;
    // Tracks the last catalog fetch failure timestamp for backoff.
    lastFetchErrorAt = 0;
    // Duration of the current cooldown (may be overridden by Retry-After header on 429).
    fetchCooldownMs = FETCH_ERROR_COOLDOWN;
    constructor(runtime, config) {
        super(runtime);
        this.runtime = runtime;
        // Resolve configuration from runtime settings or config
        const skillsDirSetting = runtime.getSetting("SKILLS_DIR") ??
            runtime.getSetting("CLAWHUB_SKILLS_DIR");
        const skillsDir = config?.skillsDir ||
            (typeof skillsDirSetting === "string" ? skillsDirSetting : null) ||
            "./skills";
        const storageTypeSetting = runtime.getSetting("SKILLS_STORAGE_TYPE");
        const storageType = config?.storageType ||
            (typeof storageTypeSetting === "string"
                ? storageTypeSetting
                : null) ||
            "auto";
        const registrySetting = runtime.getSetting("SKILLS_REGISTRY") ??
            runtime.getSetting("CLAWHUB_REGISTRY");
        this.apiBase =
            config?.registryUrl ||
                (typeof registrySetting === "string" ? registrySetting : null) ||
                CLAWHUB_API;
        this.syncCatalogOnStart =
            config?.syncCatalogOnStart ??
                runtime.getSetting("SKILLS_SYNC_CATALOG_ON_START") !== "false";
        this.autoLoad =
            config?.autoLoad ??
                (runtime.getSetting("SKILLS_AUTO_LOAD") !== "false" &&
                    runtime.getSetting("CLAWHUB_AUTO_LOAD") !== "false");
        // Bundled skills directories from config or runtime settings
        // Can be comma-separated string or array
        const bundledDirsConfig = config?.bundledSkillsDirs ||
            runtime.getSetting("BUNDLED_SKILLS_DIRS") ||
            runtime.getSetting("OTTO_BUNDLED_SKILLS_DIR");
        if (Array.isArray(bundledDirsConfig)) {
            this.bundledSkillsDirs = bundledDirsConfig.filter(Boolean);
        }
        else if (typeof bundledDirsConfig === "string" &&
            bundledDirsConfig.trim()) {
            this.bundledSkillsDirs = bundledDirsConfig
                .split(",")
                .map((d) => d.trim())
                .filter(Boolean);
        }
        else {
            this.bundledSkillsDirs = [];
        }
        // Phase 4.1: Workspace skills directory (highest precedence)
        const workspaceDirConfig = config?.workspaceSkillsDir ||
            runtime.getSetting("WORKSPACE_SKILLS_DIR") ||
            runtime.getSetting("OTTO_WORKSPACE_SKILLS_DIR");
        if (typeof workspaceDirConfig === "string" && workspaceDirConfig.trim()) {
            this.workspaceSkillsDir = workspaceDirConfig.trim();
        }
        // Phase 4.1: Plugin-contributed skills directories
        const pluginDirsConfig = config?.pluginSkillsDirs ||
            runtime.getSetting("PLUGIN_SKILLS_DIRS") ||
            runtime.getSetting("OTTO_PLUGIN_SKILLS_DIRS");
        this.pluginSkillsDirs = this.parseDirectoryList(pluginDirsConfig);
        // Phase 4.1: Extra directories (lowest precedence)
        const extraDirsConfig = config?.extraDirs ||
            runtime.getSetting("EXTRA_SKILLS_DIRS") ||
            runtime.getSetting("OTTO_EXTRA_SKILLS_DIRS") ||
            runtime.getSetting("skills.load.extraDirs");
        this.extraDirs = this.parseDirectoryList(extraDirsConfig);
        // Phase 4.4: Allowlist/Denylist
        const allowlistConfig = config?.allowlist ||
            runtime.getSetting("SKILLS_ALLOWLIST") ||
            runtime.getSetting("skills.allowlist");
        if (allowlistConfig) {
            this.allowlist = new Set(this.parseStringList(allowlistConfig));
        }
        const denylistConfig = config?.denylist ||
            runtime.getSetting("SKILLS_DENYLIST") ||
            runtime.getSetting("skills.denylist");
        if (denylistConfig) {
            this.denylist = new Set(this.parseStringList(denylistConfig));
        }
        // Phase 4.4: Per-skill configuration
        if (config?.skillEntries) {
            for (const [slug, entry] of Object.entries(config.skillEntries)) {
                this.skillEntries.set(slug, entry);
            }
        }
        // Phase 4.4: Auto-refresh
        this.autoRefreshEnabled =
            config?.autoRefresh ??
                runtime.getSetting("SKILLS_AUTO_REFRESH") === "true";
        this.autoRefreshInterval =
            config?.autoRefreshInterval ?? DEFAULT_AUTO_REFRESH_INTERVAL;
        // Use provided storage or create one
        this.storage =
            config?.storage ||
                createStorage({ type: storageType, basePath: skillsDir });
        // Set up cache paths for filesystem mode
        if (this.storage.type === "filesystem") {
            this.catalogCachePath = `${skillsDir}/.cache/catalog.json`;
            this.lockfilePath = `${skillsDir}/.cache/lock.json`;
        }
    }
    /**
     * Parse a directory list from config (string or array).
     */
    parseDirectoryList(config) {
        if (Array.isArray(config)) {
            return config.filter((d) => typeof d === "string" && d.trim().length > 0);
        }
        if (typeof config === "string" && config.trim()) {
            return config
                .split(",")
                .map((d) => d.trim())
                .filter(Boolean);
        }
        return [];
    }
    /**
     * Parse a string list from config (string or array).
     */
    parseStringList(config) {
        if (Array.isArray(config)) {
            return config.filter((s) => typeof s === "string");
        }
        if (typeof config === "string") {
            return config
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
        }
        return [];
    }
    static async start(runtime, config) {
        const service = new AgentSkillsService(runtime, config);
        await service.initialize();
        return service;
    }
    static async stop(_runtime) { }
    async stop() {
        this.runtime.logger.info("AgentSkills: Service stopping...");
        // Stop auto-refresh watcher
        if (this.watcherCleanup) {
            this.watcherCleanup();
            this.watcherCleanup = null;
        }
        this.loadedSkills.clear();
        this.eligibilityCache.clear();
        this.catalogCache = null;
        this.searchCache.clear();
        this.detailsCache.clear();
    }
    async initialize() {
        this.runtime.logger.info(`AgentSkills: Service initializing (storage: ${this.storage.type})...`);
        // Initialize main (managed) storage
        await this.storage.initialize();
        // Initialize all skill source storages
        await this.initializeSkillSources();
        // Load skills with correct precedence order:
        // 1. Extra dirs (lowest precedence) - loaded first, can be overridden
        // 2. Plugin-contributed skills
        // 3. Bundled skills
        // 4. Managed/installed skills
        // 5. Workspace skills (highest precedence) - loaded last, overrides all
        if (this.autoLoad) {
            await this.loadSkillsFromSource(this.extraStorages, "extra");
            await this.loadSkillsFromSource(this.pluginStorages, "plugin");
            await this.loadBundledSkills();
            await this.loadInstalledSkills();
            await this.loadWorkspaceSkills();
        }
        // Load cached catalog from disk (filesystem mode only)
        if (this.storage.type === "filesystem") {
            await this.loadCatalogFromDisk();
        }
        // Start auto-refresh watcher if enabled
        if (this.autoRefreshEnabled && this.storage.type === "filesystem") {
            this.startAutoRefresh();
        }
        // Log summary
        const counts = this.getSkillCountsBySource();
        this.runtime.logger.info(`AgentSkills: Initialized with ${this.loadedSkills.size} skills ` +
            `(workspace: ${counts.workspace}, managed: ${counts.managed}, ` +
            `bundled: ${counts.bundled}, plugin: ${counts.plugin}, extra: ${counts.extra})`);
        if (this.syncCatalogOnStart) {
            // Eagerly sync the skill catalog from the registry at startup.
            // This runs inline (non-blocking failure) so the agent boots with a
            // fresh catalog instead of waiting for the background timer.
            try {
                const result = await this.syncCatalog();
                this.runtime.logger.info(`AgentSkills: Catalog synced at startup - ${result.updated} skills available, ${result.added} new`);
            }
            catch (error) {
                // Non-fatal — the agent can still operate with the disk-cached catalog
                this.runtime.logger.warn(`AgentSkills: Startup catalog sync failed (will retry in background): ${error}`);
            }
        }
    }
    /**
     * Initialize all skill source storages.
     */
    async initializeSkillSources() {
        // Initialize workspace storage (highest precedence)
        if (this.workspaceSkillsDir) {
            try {
                this.workspaceStorage = new FileSystemSkillStore(this.workspaceSkillsDir);
                await this.workspaceStorage.initialize();
                this.runtime.logger.info(`AgentSkills: Registered workspace skills directory: ${this.workspaceSkillsDir}`);
            }
            catch (_error) {
                this.runtime.logger.debug(`AgentSkills: Workspace skills directory not accessible: ${this.workspaceSkillsDir}`);
                this.workspaceStorage = null;
            }
        }
        // Initialize bundled skills storages
        for (const bundledDir of this.bundledSkillsDirs) {
            try {
                const bundledStorage = new FileSystemSkillStore(bundledDir);
                await bundledStorage.initialize();
                this.bundledStorages.set(bundledDir, bundledStorage);
                this.runtime.logger.info(`AgentSkills: Registered bundled skills directory: ${bundledDir}`);
            }
            catch (_error) {
                this.runtime.logger.warn(`AgentSkills: Failed to initialize bundled skills directory: ${bundledDir}`);
            }
        }
        // Initialize plugin skills storages
        for (const pluginDir of this.pluginSkillsDirs) {
            try {
                const pluginStorage = new FileSystemSkillStore(pluginDir);
                await pluginStorage.initialize();
                this.pluginStorages.set(pluginDir, pluginStorage);
                this.runtime.logger.info(`AgentSkills: Registered plugin skills directory: ${pluginDir}`);
            }
            catch (_error) {
                this.runtime.logger.debug(`AgentSkills: Plugin skills directory not accessible: ${pluginDir}`);
            }
        }
        // Initialize extra skills storages (lowest precedence)
        for (const extraDir of this.extraDirs) {
            try {
                const extraStorage = new FileSystemSkillStore(extraDir);
                await extraStorage.initialize();
                this.extraStorages.set(extraDir, extraStorage);
                this.runtime.logger.info(`AgentSkills: Registered extra skills directory: ${extraDir}`);
            }
            catch (_error) {
                this.runtime.logger.debug(`AgentSkills: Extra skills directory not accessible: ${extraDir}`);
            }
        }
    }
    /**
     * Get skill counts by source type.
     */
    getSkillCountsBySource() {
        const counts = {
            workspace: 0,
            managed: 0,
            bundled: 0,
            plugin: 0,
            extra: 0,
        };
        for (const skill of this.loadedSkills.values()) {
            counts[skill.source]++;
        }
        return counts;
    }
    /**
     * Load skills from a set of storages with a specific source type.
     */
    async loadSkillsFromSource(storages, source) {
        for (const [dir, storage] of storages) {
            const slugs = await storage.listSkills();
            this.runtime.logger.debug(`AgentSkills: Found ${slugs.length} ${source} skills in ${dir}`);
            for (const slug of slugs) {
                // Check allowlist/denylist
                if (!this.isSkillAllowed(slug)) {
                    this.runtime.logger.debug(`AgentSkills: Skipping ${source} skill ${slug} (filtered by allow/denylist)`);
                    continue;
                }
                // Check if already loaded from higher precedence source
                const existing = this.loadedSkills.get(slug);
                if (existing &&
                    SKILL_SOURCE_PRECEDENCE[existing.source] >=
                        SKILL_SOURCE_PRECEDENCE[source]) {
                    this.runtime.logger.debug(`AgentSkills: Skipping ${source} skill ${slug} (${existing.source} version takes precedence)`);
                    continue;
                }
                const skill = await this.loadSkillFromStorageWithSource(storage, slug, source, dir);
                if (skill) {
                    if (existing) {
                        this.runtime.logger.info(`AgentSkills: ${source} skill ${slug} overrides ${existing.source} version from ${existing.sourceDir}`);
                        skill.overrides = `${existing.source}:${existing.sourceDir}`;
                    }
                    this.loadedSkills.set(slug, skill);
                }
            }
        }
    }
    /**
     * Load workspace skills (highest precedence).
     */
    async loadWorkspaceSkills() {
        if (!this.workspaceStorage)
            return;
        const slugs = await this.workspaceStorage.listSkills();
        this.runtime.logger.debug(`AgentSkills: Found ${slugs.length} workspace skills`);
        for (const slug of slugs) {
            const workspaceSkillsDir = this.workspaceSkillsDir;
            if (!workspaceSkillsDir) {
                this.runtime.logger.warn("AgentSkills: workspace storage is configured without a workspace skills directory");
                break;
            }
            // Check allowlist/denylist
            if (!this.isSkillAllowed(slug)) {
                this.runtime.logger.debug(`AgentSkills: Skipping workspace skill ${slug} (filtered by allow/denylist)`);
                continue;
            }
            // Workspace always wins
            const existing = this.loadedSkills.get(slug);
            const skill = await this.loadSkillFromStorageWithSource(this.workspaceStorage, slug, "workspace", workspaceSkillsDir);
            if (skill) {
                if (existing) {
                    this.runtime.logger.info(`AgentSkills: Workspace skill ${slug} overrides ${existing.source} version`);
                    skill.overrides = `${existing.source}:${existing.sourceDir}`;
                }
                this.loadedSkills.set(slug, skill);
            }
        }
    }
    /**
     * Check if a skill is allowed based on allowlist/denylist.
     */
    isSkillAllowed(slug) {
        // Denylist takes priority
        if (this.denylist.has(slug)) {
            return false;
        }
        // If allowlist is set, only allowed skills pass
        if (this.allowlist !== null) {
            return this.allowlist.has(slug);
        }
        return true;
    }
    /**
     * Start the auto-refresh watcher.
     */
    startAutoRefresh() {
        if (this.watcherCleanup)
            return;
        const watchDirs = [];
        if (this.workspaceSkillsDir) {
            watchDirs.push(this.workspaceSkillsDir);
        }
        // Only watch workspace for now (most likely to change during development)
        if (watchDirs.length === 0) {
            this.runtime.logger.debug("AgentSkills: No directories to watch for auto-refresh");
            return;
        }
        // Use polling-based watcher for simplicity
        let lastCheck = Date.now();
        const interval = setInterval(async () => {
            try {
                await this.refreshSkillsIfChanged(lastCheck);
                lastCheck = Date.now();
            }
            catch (error) {
                this.runtime.logger.error(`AgentSkills: Auto-refresh error: ${error}`);
            }
        }, this.autoRefreshInterval);
        this.watcherCleanup = () => {
            clearInterval(interval);
        };
        this.runtime.logger.info(`AgentSkills: Auto-refresh enabled (${this.autoRefreshInterval}ms interval)`);
    }
    /**
     * Refresh skills if any files have changed.
     */
    async refreshSkillsIfChanged(_since) {
        // For now, just reload workspace skills
        // A full implementation would check file mtimes
        if (this.workspaceStorage) {
            const slugs = await this.workspaceStorage.listSkills();
            for (const slug of slugs) {
                const existing = this.loadedSkills.get(slug);
                if (!existing || existing.source !== "workspace") {
                    // New skill or overriding from different source
                    await this.loadSkill(slug, { validate: true });
                }
            }
        }
    }
    /**
     * Load all skills from bundled directories.
     * These are read-only and cannot be modified or uninstalled.
     */
    async loadBundledSkills() {
        for (const [bundledDir, storage] of this.bundledStorages) {
            const slugs = await storage.listSkills();
            this.runtime.logger.debug(`AgentSkills: Found ${slugs.length} bundled skills in ${bundledDir}`);
            for (const slug of slugs) {
                // Check allowlist/denylist
                if (!this.isSkillAllowed(slug)) {
                    this.runtime.logger.debug(`AgentSkills: Skipping bundled skill ${slug} (filtered by allow/denylist)`);
                    continue;
                }
                // Check if already loaded from higher precedence source
                const existing = this.loadedSkills.get(slug);
                if (existing &&
                    SKILL_SOURCE_PRECEDENCE[existing.source] >=
                        SKILL_SOURCE_PRECEDENCE.bundled) {
                    this.runtime.logger.debug(`AgentSkills: Skipping bundled skill ${slug} (${existing.source} version takes precedence)`);
                    continue;
                }
                const skill = await this.loadSkillFromStorageWithSource(storage, slug, "bundled", bundledDir);
                if (skill) {
                    if (existing) {
                        skill.overrides = `${existing.source}:${existing.sourceDir}`;
                    }
                    this.loadedSkills.set(slug, skill);
                }
            }
        }
    }
    /**
     * Internal helper to load a skill from any storage with source tracking.
     */
    async loadSkillFromStorageWithSource(storage, slug, source, sourceDir) {
        const content = await storage.loadSkillContent(slug);
        if (!content) {
            this.runtime.logger.warn(`AgentSkills: No SKILL.md found for ${slug}`);
            return null;
        }
        const { frontmatter } = parseFrontmatter(content);
        if (!frontmatter) {
            this.runtime.logger.warn(`AgentSkills: ${slug} has invalid frontmatter`);
            return null;
        }
        const validation = validateFrontmatter(frontmatter, slug);
        if (!validation.valid) {
            this.runtime.logger.warn(`AgentSkills: ${slug} validation failed: ${validation.errors.map((e) => e.message).join(", ")}`);
        }
        for (const warning of validation.warnings) {
            this.runtime.logger.debug(`AgentSkills: ${slug} warning: ${warning.message}`);
        }
        const scripts = await storage.listFiles(slug, "scripts");
        const references = await storage.listFiles(slug, "references");
        const assets = await storage.listFiles(slug, "assets");
        const version = frontmatter.metadata?.version?.toString() || "local";
        const resolvedSkillName = typeof slug === "string" &&
            slug.length > 0 &&
            typeof frontmatter.name === "string" &&
            slug !== frontmatter.name
            ? slug
            : typeof frontmatter.name === "string"
                ? frontmatter.name
                : String(frontmatter.name || "");
        return {
            slug,
            name: resolvedSkillName,
            description: typeof frontmatter.description === "string"
                ? frontmatter.description
                : String(frontmatter.description || ""),
            version,
            content,
            frontmatter,
            path: storage.getSkillPath(slug),
            scripts,
            references,
            assets,
            loadedAt: Date.now(),
            source,
            sourceDir,
            precedence: SKILL_SOURCE_PRECEDENCE[source],
            bundledDir: source === "bundled" ? sourceDir : undefined,
        };
    }
    // ============================================================
    // PHASE 4.2: SKILL ELIGIBILITY CHECKING
    // ============================================================
    /**
     * Check if a skill is eligible for use based on its requirements.
     * Checks required binaries, environment variables, and config.
     *
     * @param slug - Skill slug or loaded skill
     * @returns Eligibility status with reasons if ineligible
     */
    async checkSkillEligibility(slugOrSkill) {
        const skill = typeof slugOrSkill === "string"
            ? this.loadedSkills.get(slugOrSkill)
            : slugOrSkill;
        if (!skill) {
            return {
                slug: typeof slugOrSkill === "string" ? slugOrSkill : "unknown",
                eligible: false,
                reasons: [
                    {
                        type: "config",
                        missing: "skill",
                        message: "Skill not found",
                    },
                ],
                checkedAt: Date.now(),
            };
        }
        // Check cache
        const cached = this.eligibilityCache.get(skill.slug);
        if (cached && Date.now() - cached.checkedAt < ELIGIBILITY_CACHE_TTL) {
            return cached;
        }
        const reasons = [];
        // Get requirements from metadata
        const metadata = skill.frontmatter.metadata?.otto;
        const requires = metadata?.requires;
        if (requires) {
            // Check required binaries
            if (requires.bins && requires.bins.length > 0) {
                const missingBins = await this.checkMissingBinaries(requires.bins);
                for (const bin of missingBins) {
                    reasons.push({
                        type: "bin",
                        missing: bin,
                        message: `Required binary '${bin}' not found in PATH`,
                        suggestion: this.getSuggestionForBinary(bin, metadata?.install),
                    });
                }
            }
            // Check required environment variables
            if (requires.env && requires.env.length > 0) {
                for (const envVar of requires.env) {
                    const value = process.env[envVar] || this.runtime.getSetting(envVar);
                    if (!value) {
                        reasons.push({
                            type: "env",
                            missing: envVar,
                            message: `Required environment variable '${envVar}' is not set`,
                            suggestion: `Set ${envVar} in your environment or agent settings`,
                        });
                    }
                }
            }
            // Check required config keys
            if (requires.config && requires.config.length > 0) {
                for (const configKey of requires.config) {
                    const value = this.runtime.getSetting(configKey);
                    if (!value) {
                        reasons.push({
                            type: "config",
                            missing: configKey,
                            message: `Required configuration '${configKey}' is not set`,
                            suggestion: `Set ${configKey} in your agent configuration`,
                        });
                    }
                }
            }
        }
        const eligibility = {
            slug: skill.slug,
            eligible: reasons.length === 0,
            reasons,
            checkedAt: Date.now(),
            installOptions: metadata?.install,
        };
        // Cache the result
        this.eligibilityCache.set(skill.slug, eligibility);
        return eligibility;
    }
    /**
     * Check for missing binaries from a list.
     */
    async checkMissingBinaries(bins) {
        const missing = [];
        for (const bin of bins) {
            const exists = await this.binaryExists(bin);
            if (!exists) {
                missing.push(bin);
            }
        }
        return missing;
    }
    /**
     * Check if a binary exists in PATH.
     */
    async binaryExists(name) {
        try {
            const { execSync } = await import("node:child_process");
            const platform = process.platform;
            const command = platform === "win32" ? `where ${name}` : `which ${name}`;
            execSync(command, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * Get installation suggestion for a missing binary.
     */
    getSuggestionForBinary(bin, installOptions) {
        if (!installOptions)
            return undefined;
        // Find install options that provide this binary
        const options = installOptions.filter((opt) => opt.bins?.includes(bin));
        if (options.length === 0)
            return undefined;
        // Prefer brew on macOS, apt on Linux
        const platform = process.platform;
        const preferred = platform === "darwin"
            ? options.find((o) => o.kind === "brew")
            : options.find((o) => o.kind === "apt");
        const option = preferred || options[0];
        switch (option.kind) {
            case "brew":
                return `Install with Homebrew: brew install ${option.formula || option.package}`;
            case "apt":
                return `Install with apt: sudo apt-get install ${option.package}`;
            case "node":
                return `Install with npm: npm install -g ${option.package}`;
            case "pip":
                return `Install with pip: pip install ${option.package}`;
            case "cargo":
                return `Install with cargo: cargo install ${option.package}`;
            default:
                return option.label;
        }
    }
    /**
     * Get eligibility status for all loaded skills.
     */
    async getAllSkillEligibility() {
        const results = new Map();
        for (const [slug, skill] of this.loadedSkills) {
            const eligibility = await this.checkSkillEligibility(skill);
            results.set(slug, eligibility);
        }
        return results;
    }
    /**
     * Get only eligible skills.
     */
    async getEligibleSkills() {
        const eligible = [];
        for (const skill of this.loadedSkills.values()) {
            const eligibility = await this.checkSkillEligibility(skill);
            if (eligibility.eligible) {
                eligible.push(skill);
            }
        }
        return eligible;
    }
    /**
     * Get ineligible skills with their reasons.
     */
    async getIneligibleSkills() {
        const ineligible = [];
        for (const skill of this.loadedSkills.values()) {
            const eligibility = await this.checkSkillEligibility(skill);
            if (!eligibility.eligible) {
                ineligible.push({ skill, eligibility });
            }
        }
        return ineligible;
    }
    /**
     * Clear the eligibility cache.
     */
    clearEligibilityCache() {
        this.eligibilityCache.clear();
    }
    // ============================================================
    // PHASE 4.4: SKILL CONFIGURATION
    // ============================================================
    /**
     * Set environment variables for a specific skill.
     * These will be injected when the skill is used.
     *
     * @param skillName - Skill slug
     * @param env - Environment variables to set
     */
    setSkillEnv(skillName, env) {
        this.skillEnvOverrides.set(skillName, {
            ...this.skillEnvOverrides.get(skillName),
            ...env,
        });
        this.runtime.logger.debug(`AgentSkills: Set env overrides for skill ${skillName}`);
    }
    /**
     * Get environment variables configured for a skill.
     *
     * @param skillName - Skill slug
     * @returns Merged environment variables
     */
    getSkillEnv(skillName) {
        const skillEntry = this.skillEntries.get(skillName);
        const overrides = this.skillEnvOverrides.get(skillName);
        return {
            ...skillEntry?.env,
            ...overrides,
        };
    }
    /**
     * Set an API key for a specific skill.
     *
     * @param skillName - Skill slug
     * @param apiKey - API key value
     */
    setSkillApiKey(skillName, apiKey) {
        this.skillApiKeys.set(skillName, apiKey);
        this.runtime.logger.debug(`AgentSkills: Set API key for skill ${skillName}`);
    }
    /**
     * Get the API key for a skill.
     *
     * @param skillName - Skill slug
     * @returns API key if set
     */
    getSkillApiKey(skillName) {
        // Check direct override first
        const override = this.skillApiKeys.get(skillName);
        if (override)
            return override;
        // Check skill entry config
        const entry = this.skillEntries.get(skillName);
        return entry?.apiKey;
    }
    /**
     * Update the allowlist of skills.
     *
     * @param slugs - Skill slugs to allow (null to disable allowlist)
     */
    setAllowlist(slugs) {
        this.allowlist = slugs ? new Set(slugs) : null;
        this.runtime.logger.info(`AgentSkills: Updated allowlist (${slugs?.length ?? "disabled"} skills)`);
    }
    /**
     * Update the denylist of skills.
     *
     * @param slugs - Skill slugs to deny
     */
    setDenylist(slugs) {
        this.denylist = new Set(slugs);
        this.runtime.logger.info(`AgentSkills: Updated denylist (${slugs.length} skills)`);
    }
    /**
     * Get the current allowlist.
     */
    getAllowlist() {
        return this.allowlist ? Array.from(this.allowlist) : null;
    }
    /**
     * Get the current denylist.
     */
    getDenylist() {
        return Array.from(this.denylist);
    }
    /**
     * Set configuration for a skill.
     *
     * @param skillName - Skill slug
     * @param config - Configuration entry
     */
    setSkillConfig(skillName, config) {
        this.skillEntries.set(skillName, {
            ...this.skillEntries.get(skillName),
            ...config,
        });
        this.runtime.logger.debug(`AgentSkills: Updated config for skill ${skillName}`);
    }
    /**
     * Get configuration for a skill.
     *
     * @param skillName - Skill slug
     * @returns Skill configuration or undefined
     */
    getSkillConfig(skillName) {
        return this.skillEntries.get(skillName);
    }
    /**
     * Check if a skill is enabled.
     *
     * @param skillName - Skill slug
     * @returns True if enabled (default: true)
     */
    isSkillEnabled(skillName) {
        const entry = this.skillEntries.get(skillName);
        return entry?.enabled !== false;
    }
    /**
     * Add a plugin skills directory at runtime.
     *
     * @param dir - Directory path
     */
    async addPluginSkillsDir(dir) {
        if (this.pluginStorages.has(dir))
            return;
        try {
            const storage = new FileSystemSkillStore(dir);
            await storage.initialize();
            this.pluginStorages.set(dir, storage);
            this.pluginSkillsDirs.push(dir);
            // Load skills from this directory
            await this.loadSkillsFromSource(new Map([[dir, storage]]), "plugin");
            this.runtime.logger.info(`AgentSkills: Added plugin skills directory: ${dir}`);
        }
        catch (_error) {
            this.runtime.logger.warn(`AgentSkills: Failed to add plugin skills directory: ${dir}`);
        }
    }
    // ============================================================
    // STORAGE ACCESS
    // ============================================================
    /**
     * Get the storage backend.
     */
    getStorage() {
        return this.storage;
    }
    /**
     * Get storage type.
     */
    getStorageType() {
        return this.storage.type;
    }
    /**
     * Check if running in memory mode.
     */
    isMemoryMode() {
        return this.storage.type === "memory";
    }
    // ============================================================
    // SKILL DISCOVERY (Progressive Disclosure Level 1)
    // ============================================================
    /**
     * Get skill metadata for all loaded skills.
     * Returns minimal information suitable for system prompts.
     */
    getSkillsMetadata() {
        return Array.from(this.loadedSkills.values()).map((skill) => ({
            name: skill.name,
            description: skill.description,
            location: `${skill.path}/SKILL.md`,
        }));
    }
    /**
     * Generate JSON for available skills (for system prompts).
     */
    generateSkillsPromptJson(options = {}) {
        const metadata = this.getSkillsMetadata();
        const limited = options.maxSkills
            ? metadata.slice(0, options.maxSkills)
            : metadata;
        return generateSkillsJson(limited, {
            includeLocation: options.includeLocation ?? true,
        });
    }
    // ============================================================
    // SKILL LOADING (Progressive Disclosure Level 2)
    // ============================================================
    /**
     * Load all managed/installed skills from the main storage.
     * Respects skill source precedence ordering.
     */
    async loadInstalledSkills() {
        const slugs = await this.storage.listSkills();
        for (const slug of slugs) {
            // Check allowlist/denylist
            if (!this.isSkillAllowed(slug)) {
                this.runtime.logger.debug(`AgentSkills: Skipping managed skill ${slug} (filtered by allow/denylist)`);
                continue;
            }
            // Check if already loaded from higher precedence source
            const existing = this.loadedSkills.get(slug);
            if (existing &&
                SKILL_SOURCE_PRECEDENCE[existing.source] >=
                    SKILL_SOURCE_PRECEDENCE.managed) {
                this.runtime.logger.debug(`AgentSkills: Skipping managed skill ${slug} (${existing.source} version takes precedence)`);
                continue;
            }
            const skillsDir = this.storage.type === "filesystem"
                ? this.storage.basePath
                : "./skills";
            const skill = await this.loadSkillFromStorageWithSource(this.storage, slug, "managed", skillsDir);
            if (skill) {
                if (existing) {
                    this.runtime.logger.info(`AgentSkills: Managed skill ${slug} overrides ${existing.source} version`);
                    skill.overrides = `${existing.source}:${existing.sourceDir}`;
                }
                this.loadedSkills.set(slug, skill);
            }
        }
    }
    /**
     * Load a single skill by slug or path.
     * Checks all storage sources in precedence order.
     */
    async loadSkill(slugOrPath, _options = {}) {
        // Determine slug
        let slug;
        if (slugOrPath.includes("/")) {
            // Extract slug from path
            const parts = slugOrPath.split("/").filter(Boolean);
            slug = parts[parts.length - 1];
        }
        else {
            slug = sanitizeSlug(slugOrPath);
        }
        // Check allowlist/denylist
        if (!this.isSkillAllowed(slug)) {
            this.runtime.logger.debug(`AgentSkills: Skill ${slug} not allowed by allow/denylist`);
            return null;
        }
        // Check if already loaded
        const existing = this.loadedSkills.get(slug);
        if (existing) {
            return existing;
        }
        // Check sources in precedence order (highest to lowest)
        // 1. Workspace (highest)
        if (this.workspaceStorage && (await this.workspaceStorage.hasSkill(slug))) {
            const workspaceSkillsDir = this.workspaceSkillsDir;
            if (!workspaceSkillsDir) {
                return null;
            }
            const skill = await this.loadSkillFromStorageWithSource(this.workspaceStorage, slug, "workspace", workspaceSkillsDir);
            if (skill) {
                this.loadedSkills.set(slug, skill);
                return skill;
            }
        }
        // 2. Managed storage
        if (await this.storage.hasSkill(slug)) {
            const skillsDir = this.storage.type === "filesystem"
                ? this.storage.basePath
                : "./skills";
            const skill = await this.loadSkillFromStorageWithSource(this.storage, slug, "managed", skillsDir);
            if (skill) {
                this.loadedSkills.set(slug, skill);
                return skill;
            }
        }
        // 3. Bundled storages
        for (const [bundledDir, storage] of this.bundledStorages) {
            if (await storage.hasSkill(slug)) {
                const skill = await this.loadSkillFromStorageWithSource(storage, slug, "bundled", bundledDir);
                if (skill) {
                    this.loadedSkills.set(slug, skill);
                    return skill;
                }
            }
        }
        // 4. Plugin storages
        for (const [pluginDir, storage] of this.pluginStorages) {
            if (await storage.hasSkill(slug)) {
                const skill = await this.loadSkillFromStorageWithSource(storage, slug, "plugin", pluginDir);
                if (skill) {
                    this.loadedSkills.set(slug, skill);
                    return skill;
                }
            }
        }
        // 5. Extra storages (lowest)
        for (const [extraDir, storage] of this.extraStorages) {
            if (await storage.hasSkill(slug)) {
                const skill = await this.loadSkillFromStorageWithSource(storage, slug, "extra", extraDir);
                if (skill) {
                    this.loadedSkills.set(slug, skill);
                    return skill;
                }
            }
        }
        return null;
    }
    /**
     * Load a skill directly from content (memory mode convenience).
     */
    async loadSkillFromContent(slug, skillMdContent, additionalFiles) {
        if (!(this.storage instanceof MemorySkillStore)) {
            throw new Error("loadSkillFromContent requires memory storage mode");
        }
        await this.storage.loadFromContent(slug, skillMdContent, additionalFiles);
        return this.loadSkill(slug);
    }
    /**
     * Get skill instructions (body without frontmatter).
     */
    getSkillInstructions(slug) {
        try {
            const skill = this.loadedSkills.get(sanitizeSlug(slug));
            if (!skill)
                return null;
            const body = extractBody(skill.content);
            return {
                slug: skill.slug,
                body,
                estimatedTokens: estimateTokens(body),
            };
        }
        catch {
            return null;
        }
    }
    // ============================================================
    // RESOURCE ACCESS (Progressive Disclosure Level 3)
    // ============================================================
    /**
     * Get the appropriate storage for a skill based on its source.
     */
    getStorageForSkill(skill) {
        switch (skill.source) {
            case "workspace":
                if (this.workspaceStorage)
                    return this.workspaceStorage;
                break;
            case "bundled":
                if (skill.bundledDir) {
                    const bundledStorage = this.bundledStorages.get(skill.bundledDir);
                    if (bundledStorage)
                        return bundledStorage;
                }
                break;
            case "plugin":
                if (skill.sourceDir) {
                    const pluginStorage = this.pluginStorages.get(skill.sourceDir);
                    if (pluginStorage)
                        return pluginStorage;
                }
                break;
            case "extra":
                if (skill.sourceDir) {
                    const extraStorage = this.extraStorages.get(skill.sourceDir);
                    if (extraStorage)
                        return extraStorage;
                }
                break;
            default:
                return this.storage;
        }
        return this.storage;
    }
    /**
     * Read a reference file from a skill.
     * Injects per-skill environment variables if configured.
     */
    async readReference(slug, filename) {
        const safeSlug = sanitizeSlug(slug);
        const skill = this.loadedSkills.get(safeSlug);
        if (!skill)
            return null;
        // Validate filename (prevent path traversal)
        const safeName = filename.split("/").pop() || filename;
        const storage = this.getStorageForSkill(skill);
        const content = await storage.loadFile(safeSlug, `references/${safeName}`);
        return typeof content === "string" ? content : null;
    }
    /**
     * Get the path to a script file.
     * Returns the actual filesystem path for all skill sources.
     */
    getScriptPath(slug, filename) {
        const skill = this.loadedSkills.get(sanitizeSlug(slug));
        if (!skill)
            return null;
        const safeName = filename.split("/").pop() || filename;
        if (!skill.scripts.includes(safeName))
            return null;
        return `${skill.path}/scripts/${safeName}`;
    }
    /**
     * Read a script file content.
     */
    async readScript(slug, filename) {
        const safeSlug = sanitizeSlug(slug);
        const skill = this.loadedSkills.get(safeSlug);
        if (!skill)
            return null;
        const safeName = filename.split("/").pop() || filename;
        const storage = this.getStorageForSkill(skill);
        const content = await storage.loadFile(safeSlug, `scripts/${safeName}`);
        return typeof content === "string" ? content : null;
    }
    /**
     * Get the path to an asset file.
     */
    getAssetPath(slug, filename) {
        const skill = this.loadedSkills.get(sanitizeSlug(slug));
        if (!skill)
            return null;
        const safeName = filename.split("/").pop() || filename;
        if (!skill.assets.includes(safeName))
            return null;
        return `${skill.path}/assets/${safeName}`;
    }
    /**
     * Read an asset file content.
     */
    async readAsset(slug, filename) {
        const safeSlug = sanitizeSlug(slug);
        const skill = this.loadedSkills.get(safeSlug);
        if (!skill)
            return null;
        const safeName = filename.split("/").pop() || filename;
        const storage = this.getStorageForSkill(skill);
        const content = await storage.loadFile(safeSlug, `assets/${safeName}`);
        if (content instanceof Uint8Array)
            return content;
        if (typeof content === "string")
            return new TextEncoder().encode(content);
        return null;
    }
    /**
     * Get the environment to use when executing a skill script.
     * Merges system env with skill-specific overrides.
     */
    getSkillExecutionEnv(slug) {
        const skillEnv = this.getSkillEnv(slug);
        const apiKey = this.getSkillApiKey(slug);
        const env = {
            ...process.env,
            ...skillEnv,
        };
        if (apiKey) {
            // Inject API key with standard naming
            env.SKILL_API_KEY = apiKey;
            env[`${slug.toUpperCase().replace(/-/g, "_")}_API_KEY`] = apiKey;
        }
        return env;
    }
    // ============================================================
    // SKILL RETRIEVAL
    // ============================================================
    /**
     * Get all loaded skills.
     */
    getLoadedSkills() {
        return Array.from(this.loadedSkills.values());
    }
    /**
     * Get only bundled skills.
     */
    getBundledSkills() {
        return Array.from(this.loadedSkills.values()).filter((s) => s.source === "bundled");
    }
    /**
     * Get only managed/installed skills.
     */
    getManagedSkills() {
        return Array.from(this.loadedSkills.values()).filter((s) => s.source === "managed");
    }
    /**
     * Get only workspace skills.
     */
    getWorkspaceSkills() {
        return Array.from(this.loadedSkills.values()).filter((s) => s.source === "workspace");
    }
    /**
     * Get only plugin-contributed skills.
     */
    getPluginSkills() {
        return Array.from(this.loadedSkills.values()).filter((s) => s.source === "plugin");
    }
    /**
     * Get skills by source type.
     */
    getSkillsBySource(source) {
        return Array.from(this.loadedSkills.values()).filter((s) => s.source === source);
    }
    /**
     * Get a specific loaded skill.
     */
    getLoadedSkill(slug) {
        try {
            return this.loadedSkills.get(sanitizeSlug(slug));
        }
        catch {
            return undefined;
        }
    }
    /**
     * Check if a skill is loaded.
     */
    isLoaded(slug) {
        try {
            return this.loadedSkills.has(sanitizeSlug(slug));
        }
        catch {
            return false;
        }
    }
    /**
     * Check if a skill is bundled (read-only).
     */
    isBundled(slug) {
        const skill = this.loadedSkills.get(slug);
        return skill?.source === "bundled";
    }
    /**
     * Check if a skill is installed (in managed storage, not bundled).
     */
    async isInstalled(slug) {
        try {
            return await this.storage.hasSkill(sanitizeSlug(slug));
        }
        catch {
            return false;
        }
    }
    /**
     * Check if a skill exists (either bundled or installed).
     */
    async exists(slug) {
        const safeSlug = sanitizeSlug(slug);
        // Check bundled
        for (const storage of this.bundledStorages.values()) {
            if (await storage.hasSkill(safeSlug))
                return true;
        }
        // Check managed
        return this.storage.hasSkill(safeSlug);
    }
    /**
     * Unload a skill from memory (keeps in storage).
     */
    unloadSkill(slug) {
        try {
            return this.loadedSkills.delete(sanitizeSlug(slug));
        }
        catch {
            return false;
        }
    }
    /**
     * Get the list of bundled skills directories.
     */
    getBundledSkillsDirs() {
        return [...this.bundledSkillsDirs];
    }
    // ============================================================
    // REGISTRY OPERATIONS (ClawHub Integration)
    // ============================================================
    /**
     * Get the full skill catalog from ClawHub.
     */
    async getCatalog(options = {}) {
        const ttl = options.notOlderThan ?? CACHE_TTL.CATALOG;
        // Check cache
        if (!options.forceRefresh && this.catalogCache) {
            const age = Date.now() - this.catalogCache.cachedAt;
            if (age < ttl) {
                return this.catalogCache.data;
            }
        }
        // If a recent fetch failed, skip the network call and return whatever
        // cached data we have.  This prevents hammering the API after errors
        // (e.g. 429 rate-limit) — the periodic sync task will retry later.
        const sinceLastError = Date.now() - this.lastFetchErrorAt;
        if (this.lastFetchErrorAt > 0 && sinceLastError < this.fetchCooldownMs) {
            return this.catalogCache?.data ?? [];
        }
        // Fetch from API
        try {
            const entries = [];
            let cursor;
            do {
                const url = `${this.apiBase}/api/v1/skills?limit=100${cursor ? `&cursor=${cursor}` : ""}`;
                const response = await fetch(url, {
                    headers: { Accept: "application/json" },
                });
                if (!response.ok) {
                    if (response.status === 429) {
                        // Rate-limited: honour Retry-After header when present, otherwise
                        // fall back to the default cooldown. Log at info (expected, not broken).
                        const retryAfterHeader = response.headers.get("retry-after");
                        const retrySecs = retryAfterHeader
                            ? Number(retryAfterHeader)
                            : null;
                        const cooldownSecs = retrySecs != null && Number.isFinite(retrySecs) && retrySecs > 0
                            ? retrySecs
                            : FETCH_ERROR_COOLDOWN / 1000;
                        this.fetchCooldownMs = cooldownSecs * 1000;
                        this.lastFetchErrorAt = Date.now();
                        if (!this.catalogCache) {
                            this.catalogCache = { data: [], cachedAt: Date.now() };
                        }
                        this.runtime.logger.info(`AgentSkills: Catalog rate limited (429); backing off for ${cooldownSecs}s`);
                        return this.catalogCache.data;
                    }
                    throw new Error(`Catalog fetch failed: ${response.status}`);
                }
                const data = (await response.json());
                entries.push(...data.items);
                cursor = data.nextCursor;
            } while (cursor);
            this.catalogCache = { data: entries, cachedAt: Date.now() };
            this.lastFetchErrorAt = 0; // Clear error state on success
            this.fetchCooldownMs = FETCH_ERROR_COOLDOWN; // Reset to default cooldown
            // Save to disk in filesystem mode
            if (this.storage.type === "filesystem") {
                await this.saveCatalogToDisk();
            }
            return entries;
        }
        catch (error) {
            this.lastFetchErrorAt = Date.now();
            this.runtime.logger.warn(`AgentSkills: Catalog fetch failed (will retry after cooldown): ${error}`);
            // Ensure a cache entry exists so subsequent calls (especially from
            // providers using notOlderThan: Infinity) hit the cache instead of
            // repeatedly attempting failed network requests.
            if (!this.catalogCache) {
                this.catalogCache = { data: [], cachedAt: Date.now() };
            }
            return this.catalogCache.data;
        }
    }
    /**
     * Search ClawHub for skills.
     */
    async search(query, limit = 10, options = {}) {
        const cacheKey = `${query}:${limit}`;
        const ttl = options.notOlderThan ?? CACHE_TTL.SEARCH;
        // Check cache
        if (!options.forceRefresh) {
            const cached = this.searchCache.get(cacheKey);
            if (cached && Date.now() - cached.cachedAt < ttl) {
                return cached.data;
            }
        }
        try {
            const url = `${this.apiBase}/api/v1/search?q=${encodeURIComponent(query)}&limit=${limit}`;
            const response = await fetch(url, {
                headers: { Accept: "application/json" },
            });
            if (!response.ok) {
                throw new Error(`Search failed: ${response.status}`);
            }
            const data = (await response.json());
            const results = data.results || [];
            this.searchCache.set(cacheKey, { data: results, cachedAt: Date.now() });
            return results;
        }
        catch (error) {
            this.runtime.logger.error(`AgentSkills: Search error: ${error}`);
            return this.searchCache.get(cacheKey)?.data || [];
        }
    }
    /**
     * Get skill details from ClawHub.
     */
    async getSkillDetails(slug, options = {}) {
        const safeSlug = sanitizeSlug(slug);
        const ttl = options.notOlderThan ?? CACHE_TTL.SKILL_DETAILS;
        // Check cache
        if (!options.forceRefresh) {
            const cached = this.detailsCache.get(safeSlug);
            if (cached && Date.now() - cached.cachedAt < ttl) {
                return cached.data;
            }
        }
        try {
            const url = `${this.apiBase}/api/v1/skills/${safeSlug}`;
            const response = await fetch(url, {
                headers: { Accept: "application/json" },
            });
            if (!response.ok) {
                if (response.status === 404)
                    return null;
                throw new Error(`Details fetch failed: ${response.status}`);
            }
            const details = (await response.json());
            this.detailsCache.set(safeSlug, { data: details, cachedAt: Date.now() });
            return details;
        }
        catch (error) {
            this.runtime.logger.error(`AgentSkills: Details fetch error: ${error}`);
            return this.detailsCache.get(safeSlug)?.data || null;
        }
    }
    // ============================================================
    // SECURITY SCANNING
    // ============================================================
    /**
     * Run a security scan on a skill that was just saved to storage.
     * Returns the scan report and persists it alongside the skill.
     *
     * For filesystem storage: scans the directory on disk.
     * For memory storage: scans the in-memory package files.
     *
     * @param slug - Skill slug to scan
     * @returns The scan report
     */
    async scanInstalledSkill(slug) {
        if (this.storage instanceof FileSystemSkillStore) {
            const { scanSkillDirectory, saveScanReport } = await import("../security/index");
            const skillPath = this.storage.getSkillPath(slug);
            const report = await scanSkillDirectory(skillPath);
            await saveScanReport(skillPath, report);
            return report;
        }
        // Memory mode
        const { scanSkillPackage } = await import("../security/index");
        const memStore = this.storage;
        const pkg = memStore.getPackage(slug);
        if (!pkg) {
            return {
                scannedAt: new Date().toISOString(),
                status: "blocked",
                summary: { scannedFiles: 0, critical: 1, warn: 0, info: 0 },
                findings: [],
                manifestFindings: [
                    {
                        ruleId: "missing-skill-md",
                        severity: "critical",
                        file: "SKILL.md",
                        message: "Skill package not found in memory",
                    },
                ],
                skillPath: memStore.getSkillPath(slug),
            };
        }
        const report = scanSkillPackage(pkg.files, memStore.getSkillPath(slug));
        // Persist scan report into the memory package
        pkg.files.set(".scan-results.json", {
            path: ".scan-results.json",
            content: JSON.stringify(report, null, 2),
            isText: true,
        });
        return report;
    }
    /**
     * Handle the result of a security scan after installation.
     *
     * - "blocked": Delete the skill and throw an error
     * - "critical"/"warning": Track scan status (skill starts disabled when consumed by Eliza API)
     * - "clean": No action needed
     *
     * @returns The scan report
     * @throws Error if the skill is blocked
     */
    async handleScanResult(slug, report) {
        if (report.status === "blocked") {
            // Remove the skill entirely — it is unsafe to keep on disk
            await this.storage.deleteSkill(slug);
            const reasons = [
                ...report.findings.map((f) => f.message),
                ...report.manifestFindings.map((f) => f.message),
            ];
            throw new Error(`Skill "${slug}" blocked by security scan: ${reasons.join("; ")}`);
        }
        if (report.status === "critical" || report.status === "warning") {
            this.scanStatusMap.set(slug, report.status);
            this.runtime.logger.warn(`AgentSkills: Security scan for "${slug}": ${report.status} ` +
                `(${report.summary.critical} critical, ${report.summary.warn} warnings)`);
        }
        else {
            this.scanStatusMap.delete(slug);
        }
        return report;
    }
    /**
     * Get the scan status for a skill, or null if it was never scanned
     * (e.g. bundled/workspace skills are trusted).
     */
    getSkillScanStatus(slug) {
        return this.scanStatusMap.get(slug) ?? null;
    }
    /**
     * Load a persisted scan report from storage.
     */
    async getSkillScanReport(slug) {
        if (this.storage instanceof FileSystemSkillStore) {
            const { loadScanReport } = await import("../security/index");
            return loadScanReport(this.storage.getSkillPath(slug));
        }
        // Memory mode: read from in-memory package files
        const pkg = this.storage.getPackage(slug);
        const reportFile = pkg?.files.get(".scan-results.json");
        if (!reportFile?.isText)
            return null;
        const parsed = JSON.parse(reportFile.content);
        if (!parsed.scannedAt || !Array.isArray(parsed.findings))
            return null;
        return parsed;
    }
    /**
     * Set a skill's enabled/disabled state.
     * Updates the in-memory config entry. The Eliza API layer handles
     * database persistence when the user/agent toggles via the API.
     *
     * Returns false if the skill is not loaded or if enabling is blocked
     * by a security scan that hasn't been acknowledged.
     */
    setSkillEnabled(slug, enabled) {
        const skill = this.loadedSkills.get(slug);
        if (!skill)
            return false;
        // Block enabling skills with unacknowledged scan findings
        if (enabled) {
            const scanStatus = this.scanStatusMap.get(slug);
            if (scanStatus === "critical" || scanStatus === "warning") {
                return false;
            }
        }
        const existing = this.skillEntries.get(slug) ?? {};
        existing.enabled = enabled;
        this.skillEntries.set(slug, existing);
        return true;
    }
    // ============================================================
    // INSTALLATION
    // ============================================================
    /**
     * Install a skill from ClawHub.
     *
     * In memory mode: Downloads and loads skill into memory.
     * In filesystem mode: Downloads, extracts to disk, and loads.
     */
    async install(slug, options = {}) {
        try {
            const safeSlug = sanitizeSlug(slug);
            const version = options.version || "latest";
            // Check if already installed (unless force)
            if (!options.force && (await this.isInstalled(safeSlug))) {
                this.runtime.logger.info(`AgentSkills: ${safeSlug} already installed`);
                return true;
            }
            this.runtime.logger.info(`AgentSkills: Installing ${safeSlug}@${version}...`);
            // Get skill details
            const details = await this.getSkillDetails(safeSlug);
            if (!details) {
                throw new Error(`Skill "${safeSlug}" not found`);
            }
            const resolvedVersion = version === "latest" ? details.latestVersion.version : version;
            // Download
            const downloadUrl = `${this.apiBase}/api/v1/download?slug=${safeSlug}&version=${resolvedVersion}`;
            const response = await fetch(downloadUrl);
            if (!response.ok) {
                throw new Error(`Download failed: ${response.status}`);
            }
            const zipBuffer = await response.arrayBuffer();
            if (zipBuffer.byteLength > MAX_PACKAGE_SIZE) {
                throw new Error(`Package too large (max ${MAX_PACKAGE_SIZE / 1024 / 1024}MB)`);
            }
            // Extract and save based on storage type
            if (this.storage instanceof MemorySkillStore) {
                await this.storage.loadFromZip(safeSlug, new Uint8Array(zipBuffer));
            }
            else if (this.storage instanceof FileSystemSkillStore) {
                await this.storage.saveFromZip(safeSlug, new Uint8Array(zipBuffer));
                // Update lockfile
                await this.updateLockfile(safeSlug, resolvedVersion);
            }
            // Security scan — runs after save, before load
            // Blocked skills are deleted and an error is thrown
            const scanReport = await this.scanInstalledSkill(safeSlug);
            await this.handleScanResult(safeSlug, scanReport);
            // Load the skill
            await this.loadSkill(safeSlug);
            this.runtime.logger.info(`AgentSkills: Installed ${safeSlug}@${resolvedVersion} (scan: ${scanReport.status})`);
            return true;
        }
        catch (error) {
            this.runtime.logger.error(`AgentSkills: Install error: ${error}`);
            return false;
        }
    }
    /**
     * Install a skill from a GitHub repository.
     *
     * Supports both full repo paths and shorthand:
     * - "owner/repo" - Uses repo root
     * - "owner/repo/path/to/skill" - Uses specific subdirectory
     * - "https://github.com/owner/repo" - Full URL
     *
     * Downloads SKILL.md and any additional files in the skill directory.
     */
    async installFromGitHub(repo, options = {}) {
        try {
            // Parse repo string
            let owner;
            let repoName;
            let skillPath = options.path || "";
            const branch = options.branch || "main";
            // Handle full URL
            if (repo.startsWith("http")) {
                const url = new URL(repo);
                const parts = url.pathname.split("/").filter(Boolean);
                if (parts.length < 2) {
                    throw new Error("Invalid GitHub URL");
                }
                owner = parts[0];
                repoName = parts[1];
                if (parts.length > 2) {
                    // URL includes path: /owner/repo/tree/branch/path or /owner/repo/path
                    const treeIdx = parts.indexOf("tree");
                    if (treeIdx >= 0 && parts.length > treeIdx + 2) {
                        skillPath = parts.slice(treeIdx + 2).join("/");
                    }
                    else if (parts.length > 2) {
                        skillPath = parts.slice(2).join("/");
                    }
                }
            }
            else {
                // Handle shorthand: owner/repo or owner/repo/path
                const parts = repo.split("/");
                if (parts.length < 2) {
                    throw new Error("Invalid repo format. Use owner/repo or owner/repo/path");
                }
                owner = parts[0];
                repoName = parts[1];
                if (parts.length > 2) {
                    skillPath = parts.slice(2).join("/");
                }
            }
            // Derive slug from path or repo name
            const slug = skillPath
                ? skillPath.split("/").pop() || repoName
                : repoName;
            const safeSlug = sanitizeSlug(slug);
            // Check if already installed (unless force)
            if (!options.force && (await this.isInstalled(safeSlug))) {
                this.runtime.logger.info(`AgentSkills: ${safeSlug} already installed from GitHub`);
                return true;
            }
            this.runtime.logger.info(`AgentSkills: Installing from GitHub ${owner}/${repoName}/${skillPath}...`);
            // Construct raw GitHub URLs
            const basePath = skillPath ? `${skillPath}/` : "";
            const rawBase = `https://raw.githubusercontent.com/${owner}/${repoName}/${branch}/${basePath}`;
            // Download SKILL.md
            const skillMdUrl = `${rawBase}SKILL.md`;
            const response = await fetch(skillMdUrl);
            if (!response.ok) {
                throw new Error(`Failed to fetch SKILL.md: ${response.status} from ${skillMdUrl}`);
            }
            const skillMdContent = await response.text();
            // Create a minimal skill package
            const files = [
                { name: "SKILL.md", content: skillMdContent },
            ];
            // Try to fetch README.md if it exists (optional)
            try {
                const readmeUrl = `${rawBase}README.md`;
                const readmeResponse = await fetch(readmeUrl);
                if (readmeResponse.ok) {
                    const readmeContent = await readmeResponse.text();
                    files.push({ name: "README.md", content: readmeContent });
                }
            }
            catch {
                // README is optional, ignore errors
            }
            // Save to storage
            if (this.storage instanceof MemorySkillStore) {
                await this.storage.savePackage({
                    slug: safeSlug,
                    files,
                    loadedAt: Date.now(),
                });
            }
            else if (this.storage instanceof FileSystemSkillStore) {
                // For filesystem, save files to disk
                const fs = await import("node:fs/promises");
                const path = await import("node:path");
                const skillDir = path.join(this.storage.basePath, safeSlug);
                await fs.mkdir(skillDir, { recursive: true });
                for (const file of files) {
                    await fs.writeFile(path.join(skillDir, file.name), file.content);
                }
            }
            // Security scan — runs after save, before load
            const scanReport = await this.scanInstalledSkill(safeSlug);
            await this.handleScanResult(safeSlug, scanReport);
            // Load the skill
            await this.loadSkill(safeSlug);
            this.runtime.logger.info(`AgentSkills: Installed ${safeSlug} from GitHub (scan: ${scanReport.status})`);
            return true;
        }
        catch (error) {
            this.runtime.logger.error(`AgentSkills: GitHub install error: ${error}`);
            return false;
        }
    }
    /**
     * Install a skill from a direct URL to a SKILL.md file or zip package.
     */
    async installFromUrl(url, options = {}) {
        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Failed to fetch: ${response.status}`);
            }
            const contentType = response.headers.get("content-type") || "";
            // Determine slug from URL or options
            const urlPath = new URL(url).pathname;
            const derivedSlug = options.slug ||
                urlPath
                    .split("/")
                    .filter(Boolean)
                    .pop()
                    ?.replace(/\.(md|zip)$/i, "") ||
                "skill";
            const safeSlug = sanitizeSlug(derivedSlug);
            if (contentType.includes("application/zip") || url.endsWith(".zip")) {
                // Handle zip package
                const zipBuffer = await response.arrayBuffer();
                if (zipBuffer.byteLength > MAX_PACKAGE_SIZE) {
                    throw new Error(`Package too large (max ${MAX_PACKAGE_SIZE / 1024 / 1024}MB)`);
                }
                if (this.storage instanceof MemorySkillStore) {
                    await this.storage.loadFromZip(safeSlug, new Uint8Array(zipBuffer));
                }
                else if (this.storage instanceof FileSystemSkillStore) {
                    await this.storage.saveFromZip(safeSlug, new Uint8Array(zipBuffer));
                }
            }
            else {
                // Assume it's a SKILL.md file
                const content = await response.text();
                const files = [
                    { name: "SKILL.md", content },
                ];
                if (this.storage instanceof MemorySkillStore) {
                    await this.storage.savePackage({
                        slug: safeSlug,
                        files,
                        loadedAt: Date.now(),
                    });
                }
                else if (this.storage instanceof FileSystemSkillStore) {
                    const fs = await import("node:fs/promises");
                    const path = await import("node:path");
                    const skillDir = path.join(this.storage.basePath, safeSlug);
                    await fs.mkdir(skillDir, { recursive: true });
                    for (const file of files) {
                        await fs.writeFile(path.join(skillDir, file.name), file.content);
                    }
                }
            }
            // Security scan — runs after save, before load
            const scanReport = await this.scanInstalledSkill(safeSlug);
            await this.handleScanResult(safeSlug, scanReport);
            // Load the skill
            await this.loadSkill(safeSlug);
            this.runtime.logger.info(`AgentSkills: Installed ${safeSlug} from URL (scan: ${scanReport.status})`);
            return true;
        }
        catch (error) {
            this.runtime.logger.error(`AgentSkills: URL install error: ${error}`);
            return false;
        }
    }
    /**
     * Uninstall a skill (remove from storage and memory).
     * Cannot uninstall bundled skills - they are read-only.
     */
    async uninstall(slug) {
        const safeSlug = sanitizeSlug(slug);
        // Check if this is a bundled skill
        const existing = this.loadedSkills.get(safeSlug);
        if (existing?.source === "bundled") {
            this.runtime.logger.warn(`AgentSkills: Cannot uninstall bundled skill ${safeSlug}`);
            return false;
        }
        // Unload from memory
        this.loadedSkills.delete(safeSlug);
        // Remove from managed storage
        const deleted = await this.storage.deleteSkill(safeSlug);
        if (deleted) {
            this.runtime.logger.info(`AgentSkills: Uninstalled ${safeSlug}`);
        }
        return deleted;
    }
    // ============================================================
    // SYNC OPERATIONS
    // ============================================================
    /**
     * Sync the skill catalog from ClawHub.
     */
    async syncCatalog() {
        const oldCount = this.catalogCache?.data.length || 0;
        await this.getCatalog({ forceRefresh: true });
        const newCount = this.catalogCache?.data.length || 0;
        return {
            added: Math.max(0, newCount - oldCount),
            updated: newCount,
        };
    }
    /**
     * Get catalog stats for logging.
     */
    getCatalogStats() {
        const categories = new Set();
        if (this.catalogCache?.data) {
            for (const skill of this.catalogCache.data) {
                if (skill.tags) {
                    for (const tag of Object.keys(skill.tags)) {
                        if (tag !== "latest")
                            categories.add(tag);
                    }
                }
            }
        }
        return {
            total: this.catalogCache?.data.length || 0,
            installed: this.loadedSkills.size, // For backward compat
            loaded: this.loadedSkills.size,
            cachedAt: this.catalogCache?.cachedAt || null,
            storageType: this.storage.type,
            categories: Array.from(categories).slice(0, 20),
        };
    }
    async updateLockfile(slug, version) {
        if (!this.lockfilePath || this.storage.type !== "filesystem")
            return;
        try {
            const fs = await import("node:fs");
            const path = await import("node:path");
            const cacheDir = path.dirname(this.lockfilePath);
            if (!fs.existsSync(cacheDir)) {
                fs.mkdirSync(cacheDir, { recursive: true });
            }
            let lockfile = {};
            if (fs.existsSync(this.lockfilePath)) {
                try {
                    lockfile = JSON.parse(fs.readFileSync(this.lockfilePath, "utf-8"));
                }
                catch {
                    // Reset corrupt lockfile
                }
            }
            lockfile[slug] = { version, installedAt: new Date().toISOString() };
            fs.writeFileSync(this.lockfilePath, JSON.stringify(lockfile, null, 2));
        }
        catch {
            // Non-critical error
        }
    }
    async loadCatalogFromDisk() {
        if (!this.catalogCachePath || this.storage.type !== "filesystem")
            return;
        try {
            const fs = await import("node:fs");
            if (!fs.existsSync(this.catalogCachePath))
                return;
            const cached = JSON.parse(fs.readFileSync(this.catalogCachePath, "utf-8"));
            if (cached.data && cached.cachedAt) {
                this.catalogCache = cached;
                this.runtime.logger.debug(`AgentSkills: Loaded catalog cache (${cached.data.length} skills)`);
            }
        }
        catch {
            // Ignore
        }
    }
    async saveCatalogToDisk() {
        if (!this.catalogCache ||
            !this.catalogCachePath ||
            this.storage.type !== "filesystem")
            return;
        try {
            const fs = await import("node:fs");
            const path = await import("node:path");
            const cacheDir = path.dirname(this.catalogCachePath);
            if (!fs.existsSync(cacheDir)) {
                fs.mkdirSync(cacheDir, { recursive: true });
            }
            fs.writeFileSync(this.catalogCachePath, JSON.stringify(this.catalogCache, null, 2));
        }
        catch {
            // Non-critical error
        }
    }
}
//# sourceMappingURL=skills.js.map