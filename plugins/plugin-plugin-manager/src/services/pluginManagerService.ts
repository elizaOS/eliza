import {
  Service,
  type IAgentRuntime,
  type ServiceTypeName,
  logger,
  type Plugin as ElizaPlugin,
  createUniqueUuid,
} from '@elizaos/core';
import {
  PluginStatus,
  type PluginState,
  type PluginRegistry,
  type LoadPluginParams,
  type UnloadPluginParams,
  type PluginManagerConfig,
  PluginManagerServiceType,
  type ComponentRegistration,
  type PluginComponents,
  type InstallProgress,
} from '../types';
import path from 'path';
import fs from 'fs-extra';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { applyRuntimeExtensions, type ExtendedRuntime } from '../coreExtensions';

const execAsync = promisify(exec);

// Registry installation types and functions
interface RegistryEntry {
  name: string;
  description?: string;
  repository: string;
  npm?: {
    repo: string;
    v1?: string;
  };
  git?: {
    repo: string;
    v1?: {
      branch?: string;
      version?: string;
    };
  };
}

interface DynamicPluginInfo {
  name: string;
  version: string;
  status: 'installed' | 'loaded' | 'active' | 'inactive' | 'error' | 'needs_configuration';
  path: string;
  requiredEnvVars: Array<{
    name: string;
    description: string;
    sensitive: boolean;
    isSet: boolean;
  }>;
  errorDetails?: string;
  installedAt: Date;
  lastActivated?: Date;
}

const REGISTRY_URL =
  'https://raw.githubusercontent.com/elizaos-plugins/registry/refs/heads/main/index.json';
const CACHE_DURATION = 3600000; // 1 hour

let registryCache: {
  data: Record<string, RegistryEntry>;
  timestamp: number;
} | null = null;

// Function to reset cache for testing
export function resetRegistryCache(): void {
  registryCache = null;
}

// Registry functions
async function getLocalRegistryIndex(): Promise<Record<string, RegistryEntry>> {
  // Check cache first
  if (registryCache && Date.now() - registryCache.timestamp < CACHE_DURATION) {
    return registryCache.data;
  }

  const response = await fetch(REGISTRY_URL);
  if (!response.ok) {
    throw new Error(`Registry fetch failed: ${response.statusText}`);
  }

  const data = (await response.json()) as Record<string, RegistryEntry>;

  // Cache the result
  registryCache = {
    data,
    timestamp: Date.now(),
  };

  return data;
}

// Real plugin installation function using npm/git
async function installPlugin(
  pluginName: string,
  targetDir: string,
  version?: string,
  onProgress?: (progress: InstallProgress) => void
): Promise<void> {
  logger.info(`Installing ${pluginName}${version ? `@${version}` : ''} to ${targetDir}`);

  // Ensure target directory exists
  await fs.ensureDir(targetDir);

  onProgress?.({
    phase: 'downloading',
    progress: 10,
    message: 'Fetching plugin registry...',
  });

  // Get registry entry to determine installation method
  const registry = await getLocalRegistryIndex();
  const entry = registry[pluginName];

  if (!entry) {
    throw new Error(`Plugin ${pluginName} not found in registry`);
  }

  // Determine installation method
  if (entry.npm?.repo) {
    // Install from npm
    const packageName = entry.npm.repo;
    const packageVersion = version || entry.npm.v1 || 'latest';

    await installFromNpm(packageName, packageVersion, targetDir, onProgress);
  } else if (entry.git?.repo) {
    // Install from git
    const gitRepo = entry.git.repo;
    const gitVersion = version || entry.git.v1?.version || entry.git.v1?.branch || 'main';

    await installFromGit(gitRepo, gitVersion, targetDir, onProgress);
  } else {
    throw new Error(`No installation method available for plugin ${pluginName}`);
  }
}

// Install plugin from npm
async function installFromNpm(
  packageName: string,
  version: string,
  targetDir: string,
  onProgress?: (progress: InstallProgress) => void
): Promise<void> {
  logger.info(`Installing npm package ${packageName}@${version}`);

  onProgress?.({
    phase: 'downloading',
    progress: 30,
    message: `Downloading ${packageName}@${version}...`,
  });

  // Install the package to the target directory
  await execAsync(`npm install ${packageName}@${version} --prefix "${targetDir}"`);

  onProgress?.({
    phase: 'installing',
    progress: 80,
    message: 'Installing dependencies...',
  });
}

// Install plugin from git repository
async function installFromGit(
  gitRepo: string,
  version: string,
  targetDir: string,
  onProgress?: (progress: InstallProgress) => void
): Promise<void> {
  logger.info(`Installing git repository ${gitRepo}#${version}`);

  // Clone the repository to a temporary directory
  const tempDir = path.join(targetDir, '..', 'temp-' + Date.now());
  await fs.ensureDir(tempDir);

  try {
    onProgress?.({
      phase: 'downloading',
      progress: 20,
      message: `Cloning repository ${gitRepo}...`,
    });

    // Clone the repository
    await execAsync(`git clone "${gitRepo}" "${tempDir}"`);

    // Checkout specific version/branch if specified
    if (version !== 'main' && version !== 'master') {
      onProgress?.({
        phase: 'extracting',
        progress: 40,
        message: `Checking out version ${version}...`,
      });

      await execAsync(`git checkout "${version}"`, { cwd: tempDir });
    }

    onProgress?.({
      phase: 'installing',
      progress: 60,
      message: 'Installing dependencies...',
    });

    // Install dependencies
    await execAsync('npm install', { cwd: tempDir });

    onProgress?.({
      phase: 'extracting',
      progress: 80,
      message: 'Copying files...',
    });

    // Copy to target directory
    await fs.copy(tempDir, targetDir);
  } finally {
    // Clean up temp directory
    await fs.remove(tempDir);
  }
}

export class PluginManagerService extends Service implements PluginRegistry {
  static override serviceType: ServiceTypeName = PluginManagerServiceType.PLUGIN_MANAGER;
  override capabilityDescription =
    'Manages dynamic loading and unloading of plugins at runtime, including registry installation';

  public plugins: Map<string, PluginState> = new Map();
  private pluginManagerConfig: PluginManagerConfig;
  private originalPlugins: ElizaPlugin[] = [];
  private originalActions: Set<string> = new Set();
  private originalProviders: Set<string> = new Set();
  private originalEvaluators: Set<string> = new Set();
  private originalServices: Set<string> = new Set();

  // Add registry installation state management
  private installedPlugins: Map<string, DynamicPluginInfo> = new Map();

  // Component tracking
  private componentRegistry: Map<string, ComponentRegistration[]> = new Map();

  // Protected plugins that cannot be registered, loaded, or unloaded by external code
  // These match the actual plugin names as defined in their respective index.ts files
  private readonly PROTECTED_PLUGINS = new Set<string>([
    'plugin-manager', // The plugin manager itself
    '@elizaos/plugin-sql', // SQL database plugin
    'bootstrap', // Bootstrap plugin
    'game-api', // Game API plugin
    'inference', // Inference engine
    'autonomy', // Autonomy plugin
    'knowledge', // Knowledge management
    '@elizaos/plugin-personality', // Personality system
    'experience', // Experience tracking
    'goals', // Goals tracking (can be removed once progression is working)
    'todo', // Todo tracking (can be removed once progression is working)
  ]);

  constructor(runtime: IAgentRuntime, config?: PluginManagerConfig) {
    super(runtime);
    this.pluginManagerConfig = {
      maxBuildAttempts: 3,
      buildTimeout: 60000,
      pluginDirectory: './plugins',
      enableHotReload: true,
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

    logger.info('[PluginManagerService] Initialized with config:', this.pluginManagerConfig);
  }

  static async start(
    runtime: IAgentRuntime,
    config?: PluginManagerConfig
  ): Promise<PluginManagerService> {
    const service = new PluginManagerService(runtime, config);
    return service;
  }

  private storeOriginalComponents(): void {
    // Store original action names
    if (this.runtime.actions) {
      for (const action of this.runtime.actions) {
        this.originalActions.add(action.name);
      }
    }

    // Store original provider names
    if (this.runtime.providers) {
      for (const provider of this.runtime.providers) {
        this.originalProviders.add(provider.name);
      }
    }

    // Store original evaluator names
    if (this.runtime.evaluators) {
      for (const evaluator of this.runtime.evaluators) {
        this.originalEvaluators.add(evaluator.name);
      }
    }

    // Store original service types
    if (this.runtime.services) {
      for (const [serviceType] of this.runtime.services) {
        this.originalServices.add(serviceType);
      }
    }
  }

  private initializeRegistry(): void {
    // Register existing plugins
    for (const plugin of this.originalPlugins) {
      const pluginId = createUniqueUuid(this.runtime, plugin.name);
      const state: PluginState = {
        id: pluginId,
        name: plugin.name,
        status: PluginStatus.LOADED,
        plugin,
        missingEnvVars: [],
        buildLog: [],
        createdAt: Date.now(),
        loadedAt: Date.now(),
        components: {
          actions: new Set(),
          providers: new Set(),
          evaluators: new Set(),
          services: new Set(),
          eventHandlers: new Map(),
        },
      };

      // Track original plugin components
      if (plugin.actions) {
        for (const action of plugin.actions) {
          state.components!.actions.add(action.name);
        }
      }
      if (plugin.providers) {
        for (const provider of plugin.providers) {
          state.components!.providers.add(provider.name);
        }
      }
      if (plugin.evaluators) {
        for (const evaluator of plugin.evaluators) {
          state.components!.evaluators.add(evaluator.name);
        }
      }
      if (plugin.services) {
        for (const service of plugin.services) {
          state.components!.services.add(service.serviceType);
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

  async loadPlugin({ pluginId, force = false }: LoadPluginParams): Promise<void> {
    const pluginState = this.plugins.get(pluginId);

    if (!pluginState) {
      throw new Error(`Plugin ${pluginId} not found in registry`);
    }

    // Don't allow force loading of protected plugins from external code
    if (force && this.isProtectedPlugin(pluginState.name)) {
      throw new Error(`Cannot force load protected plugin ${pluginState.name}`);
    }

    if (pluginState.status === PluginStatus.LOADED && !force) {
      logger.info(`[PluginManagerService] Plugin ${pluginState.name} already loaded`);
      return;
    }

    if (
      pluginState.status !== PluginStatus.READY &&
      pluginState.status !== PluginStatus.UNLOADED &&
      !force
    ) {
      throw new Error(
        `Plugin ${pluginState.name} is not ready to load (status: ${pluginState.status})`
      );
    }

    if (!pluginState.plugin) {
      throw new Error(`Plugin ${pluginState.name} has no plugin instance`);
    }

    logger.info(`[PluginManagerService] Loading plugin ${pluginState.name}...`);

    // Initialize plugin if it has an init function
    if (pluginState.plugin.init) {
      await pluginState.plugin.init({}, this.runtime);
    }

    // Register plugin components
    await this.registerPluginComponents(pluginState.plugin);

    // Update state
    this.updatePluginState(pluginId, {
      status: PluginStatus.LOADED,
      loadedAt: Date.now(),
      error: undefined,
    });

    logger.success(`[PluginManagerService] Plugin ${pluginState.name} loaded successfully`);
  }

  async unloadPlugin({ pluginId }: UnloadPluginParams): Promise<void> {
    const pluginState = this.plugins.get(pluginId);

    if (!pluginState) {
      throw new Error(`Plugin ${pluginId} not found in registry`);
    }

    if (pluginState.status !== PluginStatus.LOADED) {
      logger.info(`[PluginManagerService] Plugin ${pluginState.name} is not loaded`);
      return;
    }

    // Check if this is an original plugin
    const isOriginal = this.originalPlugins.some((p) => p.name === pluginState.name);
    if (isOriginal) {
      throw new Error(`Cannot unload original plugin ${pluginState.name}`);
    }

    // Check if this is a protected plugin
    if (this.isProtectedPlugin(pluginState.name)) {
      throw new Error(`Cannot unload protected plugin ${pluginState.name}`);
    }

    logger.info(`[PluginManagerService] Unloading plugin ${pluginState.name}...`);

    if (!pluginState.plugin) {
      throw new Error(`Plugin ${pluginState.name} has no plugin instance`);
    }

    // Unregister plugin components
    await this.unregisterPluginComponents(pluginState.plugin);

    // Update state
    this.updatePluginState(pluginId, {
      status: PluginStatus.UNLOADED,
      unloadedAt: Date.now(),
    });

    logger.success(`[PluginManagerService] Plugin ${pluginState.name} unloaded successfully`);
  }

  async registerPlugin(plugin: ElizaPlugin): Promise<string> {
    const pluginId = createUniqueUuid(this.runtime, plugin.name);

    if (this.plugins.has(pluginId)) {
      throw new Error(`Plugin ${plugin.name} already registered`);
    }

    // Check if trying to register a duplicate of an original plugin
    const isOriginalName = this.originalPlugins.some((p) => p.name === plugin.name);
    if (isOriginalName) {
      throw new Error(
        `Cannot register a plugin with the same name as an original plugin: ${plugin.name}`
      );
    }

    // Check if this is an attempt to register a protected plugin
    if (this.isProtectedPlugin(plugin.name)) {
      throw new Error(`Cannot register protected plugin: ${plugin.name}`);
    }

    const state: PluginState = {
      id: pluginId,
      name: plugin.name,
      status: PluginStatus.READY,
      plugin,
      missingEnvVars: [],
      buildLog: [],
      createdAt: Date.now(),
      components: {
        actions: new Set(),
        providers: new Set(),
        evaluators: new Set(),
        services: new Set(),
        eventHandlers: new Map(),
      },
    };

    this.plugins.set(pluginId, state);

    return pluginId;
  }

  private trackComponentRegistration(
    pluginId: string,
    componentType: ComponentRegistration['componentType'],
    componentName: string
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
    this.componentRegistry.get(pluginId)!.push(registration);
  }

  private async registerPluginComponents(plugin: ElizaPlugin): Promise<void> {
    const pluginState = Array.from(this.plugins.values()).find((p) => p.plugin === plugin);
    if (!pluginState) {
      throw new Error('Plugin state not found during component registration');
    }

    // Register actions
    if (plugin.actions) {
      for (const action of plugin.actions) {
        await this.runtime.registerAction(action);
        pluginState.components!.actions.add(action.name);
        this.trackComponentRegistration(pluginState.id, 'action', action.name);
      }
    }

    // Register providers
    if (plugin.providers) {
      for (const provider of plugin.providers) {
        await this.runtime.registerProvider(provider);
        pluginState.components!.providers.add(provider.name);
        this.trackComponentRegistration(pluginState.id, 'provider', provider.name);
      }
    }

    // Register evaluators
    if (plugin.evaluators) {
      for (const evaluator of plugin.evaluators) {
        await this.runtime.registerEvaluator(evaluator);
        pluginState.components!.evaluators.add(evaluator.name);
        this.trackComponentRegistration(pluginState.id, 'evaluator', evaluator.name);
      }
    }

    // Register event handlers and track them
    if (plugin.events) {
      for (const [eventName, eventHandlers] of Object.entries(plugin.events)) {
        if (!pluginState.components!.eventHandlers.has(eventName)) {
          pluginState.components!.eventHandlers.set(eventName, new Set());
        }
        for (const eventHandler of eventHandlers) {
          await this.runtime.registerEvent(eventName, eventHandler);
          pluginState.components!.eventHandlers.get(eventName)!.add(eventHandler);
          this.trackComponentRegistration(pluginState.id, 'eventHandler', eventName);
        }
      }
    }

    // Register services via the runtime's registerService method
    if (plugin.services) {
      for (const ServiceClass of plugin.services) {
        await this.runtime.registerService(ServiceClass);
        const serviceType = ServiceClass.serviceType as ServiceTypeName;
        pluginState.components!.services.add(serviceType);
        this.trackComponentRegistration(pluginState.id, 'service', serviceType);
      }
    }

    // Add plugin to runtime plugins array
    if (!this.runtime.plugins) {
      this.runtime.plugins = [];
    }
    this.runtime.plugins.push(plugin);
  }

  private async unregisterPluginComponents(plugin: ElizaPlugin): Promise<void> {
    const pluginState = Array.from(this.plugins.values()).find((p) => p.plugin === plugin);
    if (!pluginState || !pluginState.components) {
      logger.warn('Plugin state or components not found during unregistration');
      return;
    }

    // Remove actions (by filtering out plugin actions)
    if (plugin.actions && this.runtime.actions) {
      for (const action of plugin.actions) {
        if (!this.originalActions.has(action.name)) {
          const index = this.runtime.actions.findIndex((a) => a.name === action.name);
          if (index !== -1) {
            this.runtime.actions.splice(index, 1);
            pluginState.components.actions.delete(action.name);
            logger.debug(`Unregistered action: ${action.name}`);
          }
        }
      }
    }

    // Remove providers (by filtering out plugin providers)
    if (plugin.providers && this.runtime.providers) {
      for (const provider of plugin.providers) {
        if (!this.originalProviders.has(provider.name)) {
          const index = this.runtime.providers.findIndex((p) => p.name === provider.name);
          if (index !== -1) {
            this.runtime.providers.splice(index, 1);
            pluginState.components.providers.delete(provider.name);
            logger.debug(`Unregistered provider: ${provider.name}`);
          }
        }
      }
    }

    // Remove evaluators (by filtering out plugin evaluators)
    if (plugin.evaluators && this.runtime.evaluators) {
      for (const evaluator of plugin.evaluators) {
        if (!this.originalEvaluators.has(evaluator.name)) {
          const index = this.runtime.evaluators.findIndex((e) => e.name === evaluator.name);
          if (index !== -1) {
            this.runtime.evaluators.splice(index, 1);
            pluginState.components.evaluators.delete(evaluator.name);
            logger.debug(`Unregistered evaluator: ${evaluator.name}`);
          }
        }
      }
    }

    // Unregister event handlers
    if (pluginState.components.eventHandlers.size > 0) {
      const extendedRuntime = this.runtime as ExtendedRuntime;
      for (const [eventName, handlers] of pluginState.components.eventHandlers) {
        for (const handler of handlers) {
          if (extendedRuntime.unregisterEvent) {
            extendedRuntime.unregisterEvent(eventName, handler);
            logger.debug(`Unregistered event handler for: ${eventName}`);
          }
        }
      }
      pluginState.components.eventHandlers.clear();
    }

    // Stop and remove services
    if (plugin.services) {
      const extendedRuntime = this.runtime as ExtendedRuntime;
      for (const ServiceClass of plugin.services) {
        const serviceType = ServiceClass.serviceType;
        if (!this.originalServices.has(serviceType)) {
          const services = this.runtime.getServicesByType(serviceType as ServiceTypeName);
          if (services && services.length > 0) {
            for (const service of services) {
              await service.stop();
            }
            logger.debug(`Stopped services for: ${serviceType}`);
            // Remove from the services map
            const allServices = this.runtime.getAllServices();
            allServices.delete(serviceType as ServiceTypeName);
            pluginState.components.services.delete(serviceType);
            logger.debug(`Unregistered services: ${serviceType}`);
          }
        }
      }
    }

    // Remove plugin from runtime plugins array
    if (this.runtime.plugins) {
      const index = this.runtime.plugins.findIndex((p) => p.name === plugin.name);
      if (index !== -1) {
        this.runtime.plugins.splice(index, 1);
      }
    }

    // Clear component registry for this plugin
    this.componentRegistry.delete(pluginState.id);
  }

  // Helper method to get plugin components
  getPluginComponents(pluginId: string): PluginComponents | undefined {
    const pluginState = this.plugins.get(pluginId);
    return pluginState?.components;
  }

  // Helper method to get component registrations
  getComponentRegistrations(pluginId: string): ComponentRegistration[] {
    return this.componentRegistry.get(pluginId) || [];
  }

  async stop(): Promise<void> {
    logger.info('[PluginManagerService] Stopping...');
    // Clean up any resources
  }

  /**
   * Checks if a plugin name is protected and cannot be modified
   * Also checks for name variations (with/without @elizaos/ prefix)
   */
  private isProtectedPlugin(pluginName: string): boolean {
    // Check exact match
    if (this.PROTECTED_PLUGINS.has(pluginName)) {
      return true;
    }

    // Check without @elizaos/ prefix
    const withoutPrefix = pluginName.replace(/^@elizaos\//, '');
    if (this.PROTECTED_PLUGINS.has(withoutPrefix)) {
      return true;
    }

    // Check with @elizaos/ prefix added
    if (
      !pluginName.startsWith('@elizaos/') &&
      this.PROTECTED_PLUGINS.has(`@elizaos/${pluginName}`)
    ) {
      return true;
    }

    // Also protect original plugins (loaded at startup)
    return this.originalPlugins.some((p) => p.name === pluginName);
  }

  /**
   * Gets the list of protected plugin names
   */
  getProtectedPlugins(): string[] {
    return Array.from(this.PROTECTED_PLUGINS);
  }

  /**
   * Gets the list of original plugin names (loaded at startup)
   */
  getOriginalPlugins(): string[] {
    return this.originalPlugins.map((p) => p.name);
  }

  /**
   * Checks if a plugin can be safely unloaded
   * Returns true if the plugin can be unloaded, false if it's protected
   */
  canUnloadPlugin(pluginName: string): boolean {
    return !this.isProtectedPlugin(pluginName);
  }

  /**
   * Gets a human-readable reason why a plugin cannot be unloaded
   */
  getProtectionReason(pluginName: string): string | null {
    if (this.PROTECTED_PLUGINS.has(pluginName)) {
      return `${pluginName} is a core system plugin and cannot be unloaded`;
    }

    const withoutPrefix = pluginName.replace(/^@elizaos\//, '');
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

  // Registry installation methods
  async installPluginFromRegistry(
    pluginName: string,
    version?: string,
    onProgress?: (progress: InstallProgress) => void
  ): Promise<DynamicPluginInfo> {
    logger.info(`Installing plugin from registry: ${pluginName}${version ? `@${version}` : ''}`);

    const pluginDir = this.getPluginInstallPath(pluginName);

    // Ensure plugin directory exists
    await fs.ensureDir(path.dirname(pluginDir));

    // Install using real installation function
    await installPlugin(pluginName, pluginDir, version, onProgress);

    onProgress?.({
      phase: 'validating',
      progress: 90,
      message: 'Validating plugin...',
    });

    // Parse plugin metadata
    const metadata = await this.parsePluginMetadata(pluginDir);

    // Create plugin info
    const pluginInfo: DynamicPluginInfo = {
      name: metadata.name,
      version: metadata.version,
      status: metadata.requiredEnvVars.length > 0 ? 'needs_configuration' : 'installed',
      path: pluginDir,
      requiredEnvVars: metadata.requiredEnvVars,
      installedAt: new Date(),
    };

    this.installedPlugins.set(pluginName, pluginInfo);

    onProgress?.({
      phase: 'complete',
      progress: 100,
      message: `Plugin ${pluginName} installed successfully`,
    });

    logger.success(`Plugin ${pluginName} installed successfully`);
    return pluginInfo;
  }

  async installFromLocalBundle(
    bundlePath: string,
    onProgress?: (progress: InstallProgress) => void
  ): Promise<DynamicPluginInfo> {
    logger.info(`Installing plugin from local bundle: ${bundlePath}`);

    onProgress?.({
      phase: 'validating',
      progress: 10,
      message: 'Validating bundle...',
    });

    // Validate that the path exists
    const bundleExists = await fs.pathExists(bundlePath);
    if (!bundleExists) {
      throw new Error(`Bundle path does not exist: ${bundlePath}`);
    }

    // Check if it's a directory or a tarball
    const stats = await fs.stat(bundlePath);
    let extractPath: string;

    if (stats.isDirectory()) {
      extractPath = bundlePath;
    } else {
      // Handle compressed bundles (tar.gz, zip)
      throw new Error('Compressed bundle installation not yet implemented');
    }

    onProgress?.({
      phase: 'validating',
      progress: 30,
      message: 'Reading plugin metadata...',
    });

    // Parse plugin metadata
    const metadata = await this.parsePluginMetadata(extractPath);
    const pluginName = metadata.name;

    // Copy to installation directory
    const pluginDir = this.getPluginInstallPath(pluginName);
    await fs.ensureDir(path.dirname(pluginDir));

    onProgress?.({
      phase: 'installing',
      progress: 60,
      message: 'Copying plugin files...',
    });

    await fs.copy(extractPath, pluginDir);

    // Install dependencies if needed
    const hasNodeModules = await fs.pathExists(path.join(pluginDir, 'node_modules'));
    if (!hasNodeModules) {
      onProgress?.({
        phase: 'installing',
        progress: 80,
        message: 'Installing dependencies...',
      });

      await execAsync('npm install', { cwd: pluginDir });
    }

    // Create plugin info
    const pluginInfo: DynamicPluginInfo = {
      name: metadata.name,
      version: metadata.version,
      status: metadata.requiredEnvVars.length > 0 ? 'needs_configuration' : 'installed',
      path: pluginDir,
      requiredEnvVars: metadata.requiredEnvVars,
      installedAt: new Date(),
    };

    this.installedPlugins.set(pluginName, pluginInfo);

    onProgress?.({
      phase: 'complete',
      progress: 100,
      message: `Plugin ${pluginName} installed successfully from local bundle`,
    });

    logger.success(`Plugin ${pluginName} installed successfully from local bundle`);
    return pluginInfo;
  }

  async loadInstalledPlugin(pluginName: string): Promise<string> {
    const pluginInfo = this.installedPlugins.get(pluginName);

    if (!pluginInfo) {
      throw new Error(`Plugin ${pluginName} is not installed`);
    }

    if (pluginInfo.status === 'needs_configuration') {
      throw new Error(`Plugin ${pluginName} requires configuration before loading`);
    }

    // Load the plugin module
    const pluginModule = await this.loadPluginModule(pluginInfo.path);

    if (!pluginModule) {
      throw new Error('Failed to load plugin module');
    }

    // Register with existing plugin manager
    const pluginId = await this.registerPlugin(pluginModule);

    // Load the plugin
    await this.loadPlugin({ pluginId });

    pluginInfo.status = 'loaded';

    logger.success(`Plugin ${pluginName} loaded successfully`);
    return pluginId;
  }

  async getAvailablePluginsFromRegistry(): Promise<Record<string, RegistryEntry>> {
    return await getLocalRegistryIndex();
  }

  getInstalledPluginInfo(pluginName: string): DynamicPluginInfo | undefined {
    return this.installedPlugins.get(pluginName);
  }

  listInstalledPlugins(): DynamicPluginInfo[] {
    return Array.from(this.installedPlugins.values());
  }

  private getPluginInstallPath(pluginName: string): string {
    const sanitizedName = pluginName.replace(/[^a-zA-Z0-9-_]/g, '_');
    return path.join(
      this.pluginManagerConfig.pluginDirectory || './plugins',
      'installed',
      sanitizedName
    );
  }

  private async parsePluginMetadata(pluginPath: string): Promise<{
    name: string;
    version: string;
    requiredEnvVars: Array<{
      name: string;
      description: string;
      sensitive: boolean;
      isSet: boolean;
    }>;
  }> {
    const packageJsonPath = path.join(pluginPath, 'package.json');
    const packageJson = await fs.readJson(packageJsonPath);

    if (!packageJson) {
      throw new Error(`Failed to read package.json from ${packageJsonPath}`);
    }

    interface EnvVarConfig {
      name: string;
      description: string;
      sensitive?: boolean;
    }

    const elizaosConfig = packageJson as Record<string, Record<string, EnvVarConfig[]>>;
    const requiredEnvVarsConfig: EnvVarConfig[] = elizaosConfig?.elizaos?.requiredEnvVars || [];
    const requiredEnvVars = requiredEnvVarsConfig.map((v) => ({
      name: v.name,
      description: v.description,
      sensitive: v.sensitive || false,
      isSet: false,
    }));

    return {
      name: packageJson.name || 'unknown',
      version: packageJson.version || '0.0.0',
      requiredEnvVars,
    };
  }

  private async loadPluginModule(pluginPath: string): Promise<ElizaPlugin> {
    const packageJsonPath = path.join(pluginPath, 'package.json');
    let mainEntry = pluginPath;

    if (await fs.pathExists(packageJsonPath)) {
      const packageJson = await fs.readJson(packageJsonPath);
      if (packageJson.main) {
        mainEntry = path.resolve(pluginPath, packageJson.main);
      }
    }

    if (!path.isAbsolute(mainEntry)) {
      mainEntry = path.resolve(mainEntry);
    }

    const module = await import(mainEntry);

    // Find the plugin export
    if (module.default && this.isValidPlugin(module.default)) {
      return module.default;
    }

    for (const key of Object.keys(module)) {
      if (this.isValidPlugin(module[key])) {
        return module[key];
      }
    }

    throw new Error(`Could not find a valid plugin export in ${mainEntry}`);
  }

  private isValidPlugin(obj: unknown): obj is ElizaPlugin {
    if (!obj || typeof obj !== 'object') return false;
    const candidate = obj as Record<string, unknown>;
    return (
      typeof candidate.name === 'string' &&
      !!(candidate.actions || candidate.services || candidate.providers || candidate.evaluators || candidate.init)
    );
  }
}
