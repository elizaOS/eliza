import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import fs from "fs-extra";
import { createUniqueUuid } from "../../../entities.ts";
import { logger } from "../../../logger.ts";
import type { EventPayload } from "../../../types/events.ts";
import type { Plugin as ElizaPlugin } from "../../../types/plugin.ts";
import type { IAgentRuntime } from "../../../types/runtime.ts";
import type { ServiceTypeName } from "../../../types/service.ts";
import { Service } from "../../../types/service.ts";
import {
	applyRuntimeExtensions,
	type ExtendedRuntime,
} from "../coreExtensions.ts";
import {
	type ComponentRegistration,
	type EjectedPluginInfo,
	type EjectResult,
	type InstallProgress,
	type InstallResult,
	type LoadPluginParams,
	type PluginManagerConfig,
	PluginManagerServiceType,
	type PluginRegistry,
	type PluginState,
	PluginStatus,
	type ReinjectResult,
	type SyncResult,
	type UninstallResult,
	type UnloadPluginParams,
	type UpstreamMetadata,
} from "../types.ts";
import { resolveStateDir } from "../utils/paths.ts";
import {
	getRegistryEntry,
	loadRegistry,
	type PluginSearchResult,
	type RegistryPlugin,
	searchPluginsByContent,
} from "./pluginRegistryService.ts";

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Input validation — prevent shell injection
// ---------------------------------------------------------------------------

const VALID_PACKAGE_NAME = /^(@[a-zA-Z0-9][\w.-]*\/)?[a-zA-Z0-9][\w.-]*$/;
const VALID_VERSION = /^[a-zA-Z0-9][\w.+-]*$/;
const VALID_GIT_URL = /^https:\/\/[a-zA-Z0-9][\w./-]*\.git$/;
const VALID_BRANCH = /^[a-zA-Z0-9][\w./-]*$/;

function assertSafeForShell(
	value: string,
	label: string,
	pattern: RegExp,
): void {
	if (!pattern.test(value)) {
		throw new Error(`Invalid ${label}: "${value}"`);
	}
}

// Function to reset cache for testing
export function resetRegistryCache(): void {
	// Pass through if needed, or import directly in tests
}

/**
 * Detect the best available package manager (bun > npm).
 * Returns the command name to use for install operations.
 */
async function detectPackageManager(): Promise<string> {
	for (const cmd of ["bun", "npm"]) {
		try {
			await execAsync(`${cmd} --version`);
			return cmd;
		} catch {
			// not available, try next
		}
	}
	return "npm"; // fallback — will likely fail if npm isn't available either
}

export class PluginManagerService extends Service implements PluginRegistry {
	static override serviceType: ServiceTypeName =
		PluginManagerServiceType.PLUGIN_MANAGER;
	override capabilityDescription =
		"Manages dynamic loading and unloading of plugins at runtime, including registry installation";

	public plugins: Map<string, PluginState> = new Map();
	private pluginManagerConfig: PluginManagerConfig;
	private originalPlugins: ElizaPlugin[] = [];
	private originalActions: Set<string> = new Set();
	private originalProviders: Set<string> = new Set();
	private originalServices: Set<string> = new Set();

	// Component tracking
	private componentRegistry: Map<string, ComponentRegistration[]> = new Map();

	private installLock: Promise<void> = Promise.resolve();
	private ejectLock: Promise<void> = Promise.resolve();

	// Protected plugins that cannot be registered, loaded, or unloaded by external code
	private readonly PROTECTED_PLUGINS = new Set<string>([
		"plugin-manager",
		"@elizaos/plugin-sql",
		"bootstrap",
		"game-api",
		"inference",
		"autonomy",
		"documents",
		"experience",
		"goals",
		"todo",
	]);

	constructor(runtime?: IAgentRuntime, config?: PluginManagerConfig) {
		super(runtime);
		if (!runtime) {
			throw new Error("PluginManagerService requires a runtime");
		}
		this.pluginManagerConfig = {
			pluginDirectory: "./plugins",
			...config,
		};

		// Apply runtime extensions for plugin management
		applyRuntimeExtensions(runtime);

		// Store original plugins from runtime initialization
		this.originalPlugins = [...(runtime.plugins || [])];

		// Store original component names
		this.storeOriginalComponents();

		// Initialize registry with existing plugins
		this.initializeRegistry();

		logger.info(
			`[PluginManagerService] Initialized with config: ${JSON.stringify(this.pluginManagerConfig)}`,
		);
	}

	static async start(
		runtime: IAgentRuntime,
		config?: PluginManagerConfig,
	): Promise<PluginManagerService> {
		const service = new PluginManagerService(runtime, config);
		return service;
	}

	private storeOriginalComponents(): void {
		if (this.runtime.actions) {
			for (const action of this.runtime.actions) {
				this.originalActions.add(action.name);
			}
		}

		if (this.runtime.providers) {
			for (const provider of this.runtime.providers) {
				this.originalProviders.add(provider.name);
			}
		}

		if (this.runtime.services) {
			for (const [serviceType] of this.runtime.services) {
				this.originalServices.add(serviceType);
			}
		}
	}

	private initializeRegistry(): void {
		for (const plugin of this.originalPlugins) {
			const pluginId = createUniqueUuid(this.runtime, plugin.name);
			const state: PluginState = {
				id: pluginId,
				name: plugin.name,
				status: PluginStatus.LOADED,
				plugin,
				createdAt: Date.now(),
				loadedAt: Date.now(),
				components: {
					actions: new Set(),
					providers: new Set(),
					services: new Set(),
					eventHandlers: new Map(),
				},
			};

			if (plugin.actions) {
				for (const action of plugin.actions) {
					state.components?.actions.add(action.name);
				}
			}
			if (plugin.providers) {
				for (const provider of plugin.providers) {
					state.components?.providers.add(provider.name);
				}
			}
			if (plugin.services) {
				for (const service of plugin.services) {
					state.components?.services.add(service.serviceType);
				}
			}

			this.plugins.set(pluginId, state);
		}
	}

	getPlugin(id: string): PluginState | undefined {
		return this.plugins.get(id);
	}

	getAllPlugins(): PluginState[] {
		return Array.from(this.plugins.values());
	}

	getLoadedPlugins(): PluginState[] {
		return this.getAllPlugins().filter((p) => p.status === PluginStatus.LOADED);
	}

	updatePluginState(id: string, update: Partial<PluginState>): void {
		const existing = this.plugins.get(id);
		if (existing) {
			this.plugins.set(id, { ...existing, ...update });
		}
	}

	async loadPlugin({
		pluginId,
		force = false,
	}: LoadPluginParams): Promise<void> {
		const pluginState = this.plugins.get(pluginId);

		if (!pluginState) {
			throw new Error(`Plugin ${pluginId} not found in registry`);
		}

		if (force && this.isProtectedPlugin(pluginState.name)) {
			throw new Error(`Cannot force load protected plugin ${pluginState.name}`);
		}

		if (pluginState.status === PluginStatus.LOADED && !force) {
			logger.info(
				`[PluginManagerService] Plugin ${pluginState.name} already loaded`,
			);
			return;
		}

		if (
			pluginState.status !== PluginStatus.READY &&
			pluginState.status !== PluginStatus.UNLOADED &&
			!force
		) {
			throw new Error(
				`Plugin ${pluginState.name} is not ready to load (status: ${pluginState.status})`,
			);
		}

		if (!pluginState.plugin) {
			throw new Error(`Plugin ${pluginState.name} has no plugin instance`);
		}

		logger.info(`[PluginManagerService] Loading plugin ${pluginState.name}...`);

		if (pluginState.plugin.init) {
			await pluginState.plugin.init({}, this.runtime);
		}

		await this.registerPluginComponents(pluginState.plugin);

		this.updatePluginState(pluginId, {
			status: PluginStatus.LOADED,
			loadedAt: Date.now(),
			error: undefined,
		});

		logger.success(
			`[PluginManagerService] Plugin ${pluginState.name} loaded successfully`,
		);
	}

	async unloadPlugin({ pluginId }: UnloadPluginParams): Promise<void> {
		const pluginState = this.plugins.get(pluginId);

		if (!pluginState) {
			throw new Error(`Plugin ${pluginId} not found in registry`);
		}

		if (pluginState.status !== PluginStatus.LOADED) {
			logger.info(
				`[PluginManagerService] Plugin ${pluginState.name} is not loaded`,
			);
			return;
		}

		const isOriginal = this.originalPlugins.some(
			(p) => p.name === pluginState.name,
		);
		if (isOriginal) {
			throw new Error(`Cannot unload original plugin ${pluginState.name}`);
		}

		if (this.isProtectedPlugin(pluginState.name)) {
			throw new Error(`Cannot unload protected plugin ${pluginState.name}`);
		}

		logger.info(
			`[PluginManagerService] Unloading plugin ${pluginState.name}...`,
		);

		if (!pluginState.plugin) {
			throw new Error(`Plugin ${pluginState.name} has no plugin instance`);
		}

		await this.unregisterPluginComponents(pluginState.plugin);

		this.updatePluginState(pluginId, {
			status: PluginStatus.UNLOADED,
			unloadedAt: Date.now(),
		});

		logger.success(
			`[PluginManagerService] Plugin ${pluginState.name} unloaded successfully`,
		);
	}

	async registerPlugin(plugin: ElizaPlugin): Promise<string> {
		const pluginId = createUniqueUuid(this.runtime, plugin.name);

		if (this.plugins.has(pluginId)) {
			throw new Error(`Plugin ${plugin.name} already registered`);
		}

		const isOriginalName = this.originalPlugins.some(
			(p) => p.name === plugin.name,
		);
		if (isOriginalName) {
			throw new Error(
				`Cannot register a plugin with the same name as an original plugin: ${plugin.name}`,
			);
		}

		if (this.isProtectedPlugin(plugin.name)) {
			throw new Error(`Cannot register protected plugin: ${plugin.name}`);
		}

		const state: PluginState = {
			id: pluginId,
			name: plugin.name,
			status: PluginStatus.READY,
			plugin,
			createdAt: Date.now(),
			components: {
				actions: new Set(),
				providers: new Set(),
				services: new Set(),
				eventHandlers: new Map(),
			},
		};

		this.plugins.set(pluginId, state);

		return pluginId;
	}

	private trackComponentRegistration(
		pluginId: string,
		componentType: ComponentRegistration["componentType"],
		componentName: string,
	): void {
		const registration: ComponentRegistration = {
			pluginId,
			componentType,
			componentName,
			timestamp: Date.now(),
		};

		if (!this.componentRegistry.has(pluginId)) {
			this.componentRegistry.set(pluginId, []);
		}
		this.componentRegistry.get(pluginId)?.push(registration);
	}

	private async registerPluginComponents(plugin: ElizaPlugin): Promise<void> {
		const pluginState = Array.from(this.plugins.values()).find(
			(p) => p.plugin === plugin,
		);
		if (!pluginState) {
			throw new Error("Plugin state not found during component registration");
		}

		if (plugin.actions) {
			for (const action of plugin.actions) {
				await this.runtime.registerAction(action);
				pluginState.components?.actions.add(action.name);
				this.trackComponentRegistration(pluginState.id, "action", action.name);
			}
		}

		if (plugin.providers) {
			for (const provider of plugin.providers) {
				await this.runtime.registerProvider(provider);
				pluginState.components?.providers.add(provider.name);
				this.trackComponentRegistration(
					pluginState.id,
					"provider",
					provider.name,
				);
			}
		}

		if (plugin.events) {
			for (const [eventName, eventHandlers] of Object.entries(plugin.events)) {
				if (!eventHandlers) continue;
				if (!pluginState.components?.eventHandlers.has(eventName)) {
					pluginState.components?.eventHandlers.set(eventName, new Set());
				}
				for (const eventHandler of eventHandlers) {
					this.runtime.registerEvent(
						eventName,
						eventHandler as (params: EventPayload) => Promise<void>,
					);
					pluginState.components?.eventHandlers
						.get(eventName)
						?.add(
							eventHandler as (
								params: EventPayload,
							) => Promise<void>,
						);
					this.trackComponentRegistration(
						pluginState.id,
						"eventHandler",
						eventName,
					);
				}
			}
		}

		if (plugin.services) {
			for (const ServiceClass of plugin.services) {
				await this.runtime.registerService(ServiceClass);
				const serviceType = ServiceClass.serviceType as ServiceTypeName;
				pluginState.components?.services.add(serviceType);
				this.trackComponentRegistration(pluginState.id, "service", serviceType);
			}
		}

		if (!this.runtime.plugins) {
			this.runtime.plugins = [];
		}
		this.runtime.plugins.push(plugin);
	}

	private async unregisterPluginComponents(plugin: ElizaPlugin): Promise<void> {
		const pluginState = Array.from(this.plugins.values()).find(
			(p) => p.plugin === plugin,
		);
		if (!pluginState?.components) {
			logger.warn("Plugin state or components not found during unregistration");
			return;
		}

		if (plugin.actions && this.runtime.actions) {
			for (const action of plugin.actions) {
				if (!this.originalActions.has(action.name)) {
					const index = this.runtime.actions.findIndex(
						(a) => a.name === action.name,
					);
					if (index !== -1) {
						this.runtime.actions.splice(index, 1);
						pluginState.components.actions.delete(action.name);
						logger.debug(`Unregistered action: ${action.name}`);
					}
				}
			}
		}

		if (plugin.providers && this.runtime.providers) {
			for (const provider of plugin.providers) {
				if (!this.originalProviders.has(provider.name)) {
					const index = this.runtime.providers.findIndex(
						(p) => p.name === provider.name,
					);
					if (index !== -1) {
						this.runtime.providers.splice(index, 1);
						pluginState.components.providers.delete(provider.name);
						logger.debug(`Unregistered provider: ${provider.name}`);
					}
				}
			}
		}

		if (pluginState.components.eventHandlers.size > 0) {
			const extendedRuntime = this.runtime as ExtendedRuntime;
			for (const [eventName, handlers] of pluginState.components
				.eventHandlers) {
				for (const handler of handlers) {
					if (extendedRuntime.unregisterEvent) {
						extendedRuntime.unregisterEvent(eventName, handler);
						logger.debug(`Unregistered event handler for: ${eventName}`);
					}
				}
			}
			pluginState.components.eventHandlers.clear();
		}

		if (plugin.services) {
			for (const ServiceClass of plugin.services) {
				const serviceType = ServiceClass.serviceType;
				if (!this.originalServices.has(serviceType)) {
					const services = this.runtime.getServicesByType(
						serviceType as ServiceTypeName,
					);
					if (services && services.length > 0) {
						for (const service of services) {
							await service.stop();
						}
						logger.debug(`Stopped services for: ${serviceType}`);
						const allServices = this.runtime.getAllServices();
						allServices.delete(serviceType as ServiceTypeName);
						pluginState.components.services.delete(serviceType);
						logger.debug(`Unregistered services: ${serviceType}`);
					}
				}
			}
		}

		if (this.runtime.plugins) {
			const index = this.runtime.plugins.findIndex(
				(p) => p.name === plugin.name,
			);
			if (index !== -1) {
				this.runtime.plugins.splice(index, 1);
			}
		}

		this.componentRegistry.delete(pluginState.id);
	}

	async stop(): Promise<void> {
		logger.info("[PluginManagerService] Stopping...");

		for (const [pluginId, pluginState] of this.plugins) {
			if (
				pluginState.status === PluginStatus.LOADED &&
				!this.originalPlugins.some((p) => p.name === pluginState.name)
			) {
				try {
					if (pluginState.plugin) {
						await this.unregisterPluginComponents(pluginState.plugin);
					}
					this.updatePluginState(pluginId, { status: PluginStatus.UNLOADED });
					logger.info(
						`[PluginManagerService] Unloaded dynamic plugin: ${pluginState.name}`,
					);
				} catch (error) {
					logger.warn(
						{ src: "plugin-manager", error },
						`[PluginManagerService] Failed to unload ${pluginState.name} during shutdown`,
					);
				}
			}
		}

		this.componentRegistry.clear();
		logger.info("[PluginManagerService] Stopped");
	}

	private isProtectedPlugin(pluginName: string): boolean {
		if (this.PROTECTED_PLUGINS.has(pluginName)) {
			return true;
		}
		const withoutPrefix = pluginName.replace(/^@elizaos\//, "");
		if (this.PROTECTED_PLUGINS.has(withoutPrefix)) {
			return true;
		}
		if (
			!pluginName.startsWith("@elizaos/") &&
			this.PROTECTED_PLUGINS.has(`@elizaos/${pluginName}`)
		) {
			return true;
		}
		return this.originalPlugins.some((p) => p.name === pluginName);
	}

	getProtectedPlugins(): string[] {
		return Array.from(this.PROTECTED_PLUGINS);
	}

	getOriginalPlugins(): string[] {
		return this.originalPlugins.map((p) => p.name);
	}

	canUnloadPlugin(pluginName: string): boolean {
		return !this.isProtectedPlugin(pluginName);
	}

	getProtectionReason(pluginName: string): string | null {
		if (this.PROTECTED_PLUGINS.has(pluginName)) {
			return `${pluginName} is a core system plugin and cannot be unloaded`;
		}
		const withoutPrefix = pluginName.replace(/^@elizaos\//, "");
		if (
			this.PROTECTED_PLUGINS.has(withoutPrefix) ||
			this.PROTECTED_PLUGINS.has(`@elizaos/${pluginName}`)
		) {
			return `${pluginName} is a core system plugin and cannot be unloaded`;
		}
		if (this.originalPlugins.some((p) => p.name === pluginName)) {
			return `${pluginName} was loaded at startup and is required for agent operation`;
		}
		return null;
	}

	// ---------------------------------------------------------------------------
	// Registry & Plugin Installation Logic
	// ---------------------------------------------------------------------------

	private serialiseInstall<T>(fn: () => Promise<T>): Promise<T> {
		const prev = this.installLock;
		let resolve: () => void;
		this.installLock = new Promise<void>((r) => {
			resolve = r;
		});
		return prev.then(fn).finally(() => resolve?.());
	}

	private serialiseEject<T>(fn: () => Promise<T>): Promise<T> {
		const prev = this.ejectLock;
		let resolve: () => void;
		this.ejectLock = new Promise<void>((r) => {
			resolve = r;
		});
		return prev.then(fn).finally(() => resolve?.());
	}

	private getPluginsBaseDir(): string {
		return path.join(resolveStateDir(), "plugins", "installed");
	}

	private getEjectedBaseDir(): string {
		return path.join(resolveStateDir(), "plugins", "ejected");
	}

	private isWithinDir(targetPath: string, baseDir: string): boolean {
		const base = path.resolve(baseDir);
		const resolved = path.resolve(targetPath);
		if (resolved === base) return false;
		return resolved.startsWith(`${base}${path.sep}`);
	}

	private sanitisePackageName(name: string): string {
		return name.replace(/[^a-zA-Z0-9._-]/g, "_");
	}

	private getPluginInstallPath(pluginName: string): string {
		return path.join(
			this.getPluginsBaseDir(),
			this.sanitisePackageName(pluginName),
		);
	}

	/**
	 * Install a plugin from the registry.
	 * Supports `PLUGIN_MANAGER_LOCAL_CLONE` to auto-clone instead of npm install.
	 */
	async installPlugin(
		pluginName: string,
		onProgress?: (progress: InstallProgress) => void,
	): Promise<InstallResult> {
		return this.serialiseInstall(async () => {
			onProgress?.({
				phase: "resolving",
				message: `Looking up ${pluginName} in registry...`,
			});

			const info = await getRegistryEntry(pluginName);
			if (!info) {
				return {
					success: false,
					pluginName,
					version: "",
					installPath: "",
					requiresRestart: false,
					error: `Plugin "${pluginName}" not found in the registry`,
				};
			}

			const canonicalName = info.name;
			const npmVersion = info.npm.v2Version || info.npm.v1Version || "next";
			const targetDir = this.getPluginInstallPath(canonicalName);

			const shouldClone = process.env.PLUGIN_MANAGER_LOCAL_CLONE === "true";

			await fs.ensureDir(targetDir);

			const targetPkgPath = path.join(targetDir, "package.json");
			if (!(await fs.pathExists(targetPkgPath))) {
				await fs.writeJson(
					targetPkgPath,
					{ private: true, dependencies: {} },
					{ spaces: 2 },
				);
			}

			let installedVersion = npmVersion;
			let installed = false;

			if (shouldClone) {
				try {
					const ejectedDir = path.join(
						this.getEjectedBaseDir(),
						this.sanitisePackageName(canonicalName),
					);
					await this.clonePluginTo(info, ejectedDir, onProgress);

					await fs.remove(targetDir);
					await fs.ensureSymlink(
						ejectedDir,
						targetDir,
						"junction" as fs.SymlinkType,
					);

					installed = true;
					installedVersion = "git-clone";
				} catch (err) {
					logger.warn(`Failed to clone ${canonicalName}: ${err}`);
				}
			}

			if (!installed) {
				try {
					await this.installFromNpm(
						canonicalName,
						npmVersion,
						targetDir,
						onProgress,
					);
					installed = true;
				} catch (err) {
					logger.warn(`npm install failed, falling back to clone: ${err}`);
					if (!shouldClone) {
						try {
							await this.installFromGit(
								info.gitUrl,
								info.git.v2Branch || "main",
								targetDir,
								onProgress,
							);
							installed = true;
							installedVersion = "git-fallback";
						} catch (gitErr) {
							return {
								success: false,
								pluginName: canonicalName,
								version: "",
								installPath: targetDir,
								requiresRestart: false,
								error: `Installation failed: ${gitErr instanceof Error ? gitErr.message : String(gitErr)}`,
							};
						}
					}
				}
			}

			if (!installed) {
				return {
					success: false,
					pluginName: canonicalName,
					version: "",
					installPath: targetDir,
					requiresRestart: false,
					error: `Failed to install plugin "${canonicalName}"`,
				};
			}

			onProgress?.({ phase: "validating", message: "Verifying plugin..." });
			const entryPoint = await this.resolveEntryPoint(targetDir, canonicalName);
			if (!entryPoint) {
				return {
					success: false,
					pluginName: canonicalName,
					version: installedVersion,
					installPath: targetDir,
					requiresRestart: false,
					error: "Plugin installed but entry point not found",
				};
			}

			onProgress?.({
				phase: "complete",
				message: `Installed ${canonicalName}@${installedVersion}`,
			});

			return {
				success: true,
				pluginName: canonicalName,
				version: installedVersion,
				installPath: targetDir,
				requiresRestart: true,
			};
		});
	}

	private async installFromNpm(
		packageName: string,
		version: string,
		targetDir: string,
		onProgress?: (progress: InstallProgress) => void,
	): Promise<void> {
		assertSafeForShell(packageName, "package name", VALID_PACKAGE_NAME);
		assertSafeForShell(version, "version", VALID_VERSION);

		const pm = await detectPackageManager();
		const spec = `${packageName}@${version}`;

		onProgress?.({
			phase: "downloading",
			message: `Running ${pm} install ${spec}...`,
		});

		switch (pm) {
			case "bun":
				await execAsync(`bun add ${spec}`, { cwd: targetDir });
				break;
			default:
				await execAsync(`npm install ${spec} --prefix "${targetDir}"`);
		}

		onProgress?.({
			phase: "installing-deps",
			message: `${pm} install complete.`,
		});
	}

	private async installFromGit(
		gitUrl: string,
		branch: string,
		targetDir: string,
		onProgress?: (progress: InstallProgress) => void,
	): Promise<void> {
		assertSafeForShell(gitUrl, "git URL", VALID_GIT_URL);
		assertSafeForShell(branch, "branch", VALID_BRANCH);

		const tempDir = path.join(path.dirname(targetDir), `temp-${Date.now()}`);
		await fs.ensureDir(tempDir);

		try {
			onProgress?.({
				phase: "downloading",
				message: `Cloning ${gitUrl}#${branch}...`,
			});
			await execAsync(
				`git clone --branch "${branch}" --single-branch --depth 1 "${gitUrl}" "${tempDir}"`,
			);

			onProgress?.({
				phase: "installing-deps",
				message: "Installing dependencies...",
			});
			const pm = await detectPackageManager();
			await execAsync(`${pm} install`, { cwd: tempDir });

			const tsDir = path.join(tempDir, "typescript");
			if (await fs.pathExists(tsDir)) {
				await execAsync(`${pm} run build`, { cwd: tsDir }).catch(() => {});
				await fs.copy(tsDir, targetDir);
			} else {
				await fs.copy(tempDir, targetDir);
			}
		} finally {
			await fs.remove(tempDir);
		}
	}

	private async clonePluginTo(
		info: RegistryPlugin,
		targetDir: string,
		onProgress?: (progress: InstallProgress) => void,
	): Promise<void> {
		const branch = info.git.v2Branch || info.git.v1Branch || "main";
		assertSafeForShell(info.gitUrl, "git URL", VALID_GIT_URL);
		assertSafeForShell(branch, "branch", VALID_BRANCH);

		if (await fs.pathExists(targetDir)) {
			throw new Error(`Target directory ${targetDir} already exists`);
		}

		onProgress?.({
			phase: "downloading",
			message: `Cloning ${info.gitUrl}#${branch} to ${targetDir}...`,
		});

		await execAsync(
			`git clone --branch "${branch}" --single-branch --depth 1 "${info.gitUrl}" "${targetDir}"`,
			{
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			},
		);

		onProgress?.({
			phase: "installing-deps",
			message: "Installing dependencies...",
		});
		const pm = await detectPackageManager();
		await execAsync(`${pm} install`, { cwd: targetDir });

		try {
			await execAsync(`${pm} run build`, { cwd: targetDir });
		} catch {} // Build might fail or not exist, continue
	}

	/**
	 * Update an installed plugin to the latest available version.
	 *
	 * Resolves the registry entry (which always points to the latest npm
	 * version) and re-runs install. The package manager treats the existing
	 * install as a no-op when the version already matches and as an upgrade
	 * otherwise.
	 */
	async updatePlugin(
		pluginName: string,
		onProgress?: (progress: InstallProgress) => void,
	): Promise<InstallResult> {
		return this.installPlugin(pluginName, onProgress);
	}

	async uninstallPlugin(pluginName: string): Promise<UninstallResult> {
		return this.serialiseInstall(async () => {
			const info = await getRegistryEntry(pluginName);
			if (!info) {
				return {
					success: false,
					pluginName,
					requiresRestart: false,
					error: `Plugin "${pluginName}" not found in registry (cannot resolve path)`,
				};
			}
			const canonicalName = info.name;
			const targetDir = this.getPluginInstallPath(canonicalName);

			if (!(await fs.pathExists(targetDir))) {
				return {
					success: false,
					pluginName,
					requiresRestart: false,
					error: `Plugin "${pluginName}" is not installed`,
				};
			}

			try {
				await fs.remove(targetDir);
				return {
					success: true,
					pluginName: canonicalName,
					requiresRestart: true,
				};
			} catch (err) {
				return {
					success: false,
					pluginName,
					requiresRestart: false,
					error: `Failed to remove plugin directory: ${err instanceof Error ? err.message : String(err)}`,
				};
			}
		});
	}

	async listInstalledPlugins(): Promise<EjectedPluginInfo[]> {
		const base = this.getPluginsBaseDir();
		if (!(await fs.pathExists(base))) return [];

		const results: EjectedPluginInfo[] = [];
		const entries = await fs.readdir(base);
		for (const e of entries) {
			const p = path.join(base, e);
			if ((await fs.stat(p)).isDirectory()) {
				const pkg = await fs
					.readJson(path.join(p, "package.json"))
					.catch(() => ({}));
				results.push({
					name: pkg.name || e,
					path: p,
					version: pkg.version || "unknown",
					upstream: null,
				});
			}
		}
		return results;
	}

	// Registry Interactions
	async searchRegistry(
		query: string,
		limit?: number,
	): Promise<PluginSearchResult[]> {
		return searchPluginsByContent(query, limit);
	}

	async getRegistryPlugin(name: string): Promise<RegistryPlugin | null> {
		return getRegistryEntry(name);
	}

	async refreshRegistry(): Promise<Map<string, RegistryPlugin>> {
		return loadRegistry();
	}

	private async resolveEntryPoint(
		targetDir: string,
		packageName: string,
	): Promise<string | null> {
		const nmPath = path.join(
			targetDir,
			"node_modules",
			...packageName.split("/"),
		);
		if (await fs.pathExists(nmPath)) return nmPath;

		const pkgPath = path.join(targetDir, "package.json");
		if (await fs.pathExists(pkgPath)) return targetDir;

		return null;
	}

	// ---------------------------------------------------------------------------
	// Eject / Sync / Reinject
	// ---------------------------------------------------------------------------

	async ejectPlugin(pluginId: string): Promise<EjectResult> {
		return this.serialiseEject(async () => {
			const info = await getRegistryEntry(pluginId);
			if (!info) {
				return {
					success: false,
					pluginName: pluginId,
					ejectedPath: "",
					upstreamCommit: "",
					requiresRestart: false,
					error: `Plugin "${pluginId}" not found`,
				};
			}

			const canonicalName = info.name;
			const base = this.getEjectedBaseDir();
			const targetDir = path.join(
				base,
				this.sanitisePackageName(canonicalName),
			);

			if (!this.isWithinDir(targetDir, base)) {
				return {
					success: false,
					pluginName: canonicalName,
					ejectedPath: targetDir,
					upstreamCommit: "",
					requiresRestart: false,
					error: `Refusing to write outside ${base}`,
				};
			}

			if (await fs.pathExists(targetDir)) {
				return {
					success: false,
					pluginName: canonicalName,
					ejectedPath: targetDir,
					upstreamCommit: "",
					requiresRestart: false,
					error: "Already ejected",
				};
			}

			const branch = info.git.v2Branch || info.git.v1Branch || "main";
			const gitUrl = info.gitUrl;

			try {
				await execAsync(
					`git clone --branch "${branch}" --single-branch --depth 1 "${gitUrl}" "${targetDir}"`,
					{
						env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
					},
				);

				const pm = await detectPackageManager();
				await execAsync(`${pm} install`, { cwd: targetDir });
				try {
					await execAsync(`${pm} run build`, { cwd: targetDir });
				} catch {}

				const commitHash = (
					await execAsync("git rev-parse HEAD", { cwd: targetDir })
				).stdout.trim();

				const metadata: UpstreamMetadata = {
					$schema: "eliza-upstream-v1",
					source: `github:${info.gitRepo}`,
					gitUrl,
					branch,
					commitHash,
					ejectedAt: new Date().toISOString(),
					npmPackage: info.npm.package || canonicalName,
					npmVersion: info.npm.v2Version || "unknown",
					lastSyncAt: null,
					localCommits: 0,
				};
				await fs.writeJson(path.join(targetDir, ".upstream.json"), metadata, {
					spaces: 2,
				});

				return {
					success: true,
					pluginName: canonicalName,
					ejectedPath: targetDir,
					upstreamCommit: commitHash,
					requiresRestart: true,
				};
			} catch (err) {
				await fs.remove(targetDir);
				return {
					success: false,
					pluginName: canonicalName,
					ejectedPath: targetDir,
					upstreamCommit: "",
					requiresRestart: false,
					error: String(err),
				};
			}
		});
	}

	async syncPlugin(pluginId: string): Promise<SyncResult> {
		return this.serialiseEject(async () => {
			const base = this.getEjectedBaseDir();
			if (!(await fs.pathExists(base)))
				return {
					success: false,
					pluginName: pluginId,
					ejectedPath: "",
					upstreamCommits: 0,
					localChanges: false,
					conflicts: [],
					commitHash: "",
					requiresRestart: false,
					error: "No ejected plugins",
				};

			let targetDir = "";
			const entries = await fs.readdir(base);
			for (const e of entries) {
				if (e.includes(this.sanitisePackageName(pluginId)) || e === pluginId) {
					targetDir = path.join(base, e);
					break;
				}
			}

			if (!targetDir) {
				return {
					success: false,
					pluginName: pluginId,
					ejectedPath: "",
					upstreamCommits: 0,
					localChanges: false,
					conflicts: [],
					commitHash: "",
					requiresRestart: false,
					error: "Plugin not found in ejected directory",
				};
			}

			const metadataPath = path.join(targetDir, ".upstream.json");
			if (!(await fs.pathExists(metadataPath))) {
				return {
					success: false,
					pluginName: pluginId,
					ejectedPath: targetDir,
					upstreamCommits: 0,
					localChanges: false,
					conflicts: [],
					commitHash: "",
					requiresRestart: false,
					error: "Missing upstream metadata",
				};
			}
			const metadata = (await fs.readJson(metadataPath)) as UpstreamMetadata;

			try {
				await execAsync(`git fetch origin ${metadata.branch}`, {
					cwd: targetDir,
				});
				const upstreamCount = (
					await execAsync(
						`git rev-list --count HEAD..origin/${metadata.branch}`,
						{
							cwd: targetDir,
						},
					)
				).stdout.trim();
				const count = parseInt(upstreamCount, 10) || 0;

				if (count > 0) {
					await execAsync(`git merge --no-edit origin/${metadata.branch}`, {
						cwd: targetDir,
					});
				}

				const commitHash = (
					await execAsync("git rev-parse HEAD", { cwd: targetDir })
				).stdout.trim();
				metadata.commitHash = commitHash;
				metadata.lastSyncAt = new Date().toISOString();
				await fs.writeJson(metadataPath, metadata, { spaces: 2 });

				return {
					success: true,
					pluginName: pluginId,
					ejectedPath: targetDir,
					upstreamCommits: count,
					localChanges: false,
					conflicts: [],
					commitHash,
					requiresRestart: count > 0,
				};
			} catch (err) {
				return {
					success: false,
					pluginName: pluginId,
					ejectedPath: targetDir,
					upstreamCommits: 0,
					localChanges: false,
					conflicts: [],
					commitHash: "",
					requiresRestart: false,
					error: String(err),
				};
			}
		});
	}

	async reinjectPlugin(pluginId: string): Promise<ReinjectResult> {
		return this.serialiseEject(async () => {
			const base = this.getEjectedBaseDir();
			let targetDir = "";
			const entries = await fs.readdir(base);
			for (const e of entries) {
				if (e.includes(this.sanitisePackageName(pluginId)) || e === pluginId) {
					targetDir = path.join(base, e);
					break;
				}
			}

			if (!targetDir)
				return {
					success: false,
					pluginName: pluginId,
					removedPath: "",
					requiresRestart: false,
					error: "Plugin not found",
				};

			await fs.remove(targetDir);
			return {
				success: true,
				pluginName: pluginId,
				removedPath: targetDir,
				requiresRestart: true,
			};
		});
	}

	async listEjectedPlugins(): Promise<EjectedPluginInfo[]> {
		const base = this.getEjectedBaseDir();
		if (!(await fs.pathExists(base))) return [];

		const results: EjectedPluginInfo[] = [];
		const entries = await fs.readdir(base);
		for (const e of entries) {
			const p = path.join(base, e);
			if ((await fs.stat(p)).isDirectory()) {
				const pkg = await fs
					.readJson(path.join(p, "package.json"))
					.catch(() => ({}));
				const upstream = await fs
					.readJson(path.join(p, ".upstream.json"))
					.catch(() => null);
				results.push({
					name: pkg.name || e,
					path: p,
					version: pkg.version || "unknown",
					upstream,
				});
			}
		}
		return results;
	}
}
