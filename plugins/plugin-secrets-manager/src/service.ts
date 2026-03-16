import { logger, Service, type IAgentRuntime, type UUID, type Plugin } from "@elizaos/core";
import type {
  EnvVarMetadata,
  GenerationScriptMetadata,
  EnvVarConfig,
} from "./types";
import { canGenerateEnvVar } from "./generation";

/**
 * Extended plugin interface that includes optional declaredEnvVars
 */
interface PluginWithEnvVars extends Plugin {
  declaredEnvVars?: Record<string, Partial<EnvVarConfig & { defaultValue?: string }>>;
}

/**
 * Environment Manager Service for handling environment variable configuration
 * Stores variables in runtime settings and character secrets for persistence
 */
export class EnvManagerService extends Service {
  static serviceType = "ENV_MANAGER";
  capabilityDescription =
    "The agent can manage environment variables for plugins, including auto-generation and validation";

  private envVarCache: EnvVarMetadata = {};

  /**
   * Start the EnvManagerService with the given runtime
   */
  static async start(runtime: IAgentRuntime): Promise<EnvManagerService> {
    const service = new EnvManagerService(runtime);
    await service.initialize();
    return service;
  }

  /**
   * Initialize the service and scan for required environment variables
   */
  async initialize(): Promise<void> {
    logger.info("[EnvManager] Initializing Environment Manager Service");

    // Load existing env vars from character secrets
    await this.loadEnvVarsFromSecrets();

    // Scan for new requirements
    await this.scanPluginRequirements();
  }

  /**
   * Load environment variables from character secrets into runtime settings
   */
  private async loadEnvVarsFromSecrets(): Promise<void> {
    try {
      const character = this.runtime.character;
      if (character.settings?.secrets) {
        logger.info(
          "[EnvManager] Loading environment variables from character secrets",
        );

        // Load env var metadata from a special key
        const envMetadata = character.settings.secrets.__env_metadata;
        if (envMetadata && typeof envMetadata === "string") {
          try {
            this.envVarCache = JSON.parse(envMetadata) as EnvVarMetadata;
          } catch (e) {
            logger.error("[EnvManager] Failed to parse env metadata:", e);
            this.envVarCache = {};
          }
        }

        // Load actual values into runtime settings
        for (const [key, value] of Object.entries(character.settings.secrets)) {
          if (key.startsWith("ENV_") && value) {
            this.runtime.setSetting(key, value);
            logger.debug(`[EnvManager] Loaded ${key} from secrets`);
          }
        }
      }
    } catch (error) {
      logger.error("[EnvManager] Error loading env vars from secrets:", error);
    }
  }

  /**
   * Save environment variable metadata to character secrets
   */
  private async saveEnvVarsToSecrets(): Promise<void> {
    try {
      const character = this.runtime.character;
      if (!character.settings) {
        character.settings = {};
      }
      if (!character.settings.secrets) {
        character.settings.secrets = {};
      }

      // Save metadata
      character.settings.secrets.__env_metadata = JSON.stringify(
        this.envVarCache,
      );

      // Save actual values from runtime settings
      for (const [pluginName, plugin] of Object.entries(this.envVarCache)) {
        for (const [varName, config] of Object.entries(plugin)) {
          if (config.value) {
            const settingKey = `ENV_${varName}`;
            character.settings.secrets[settingKey] = config.value;
            this.runtime.setSetting(settingKey, config.value);
          }
        }
      }

      logger.debug("[EnvManager] Saved env vars to character secrets");
    } catch (error) {
      logger.error("[EnvManager] Error saving env vars to secrets:", error);
    }
  }

  /**
   * Scan all loaded plugins for required environment variables
   */
  async scanPluginRequirements(): Promise<void> {
    try {
      // Scan character secrets for environment variable requirements
      const character = this.runtime.character;
      if (character.settings?.secrets) {
        await this.scanCharacterSecrets(character.settings.secrets);
      }

      // Scan loaded plugins for additional requirements
      await this.scanLoadedPlugins();

      // Save updated metadata
      await this.saveEnvVarsToSecrets();

      logger.info("[EnvManager] Plugin requirements scan completed");
    } catch (error) {
      logger.error("[EnvManager] Error scanning plugin requirements:", error);
    }
  }

  /**
   * Scan character secrets configuration
   */
  private async scanCharacterSecrets(
    secrets: Record<string, any>,
  ): Promise<void> {
    if (!this.envVarCache["character"]) {
      this.envVarCache["character"] = {};
    }

    for (const [key, value] of Object.entries(secrets)) {
      // Skip metadata and ENV_ prefixed keys
      if (key === "__env_metadata" || key.startsWith("ENV_")) {
        continue;
      }

      if (!this.envVarCache["character"][key]) {
        const settingKey = `ENV_${key}`;
        const currentValue = this.runtime.getSetting(settingKey) || value;

        const config: EnvVarConfig = {
          type: this.inferVariableType(key),
          required: true,
          description: `Character setting: ${key}`,
          canGenerate: canGenerateEnvVar(key, this.inferVariableType(key)),
          status: currentValue ? "valid" : "missing",
          attempts: 0,
          plugin: "character",
          createdAt: Date.now(),
        };

        if (currentValue) {
          config.value = currentValue;
          config.validatedAt = Date.now();
          this.runtime.setSetting(settingKey, currentValue);
        }

        this.envVarCache["character"][key] = config;
      }
    }
  }

  /**
   * Scan loaded plugins for environment variable requirements
   */
  private async scanLoadedPlugins(): Promise<void> {
    logger.debug(
      "[EnvManager] Scanning loaded plugins for environment variable requirements...",
    );

    if (!this.runtime.plugins) {
      logger.debug("[EnvManager] No runtime plugins found to scan.");
      return;
    }

    for (const pluginInstance of this.runtime.plugins) {
      if (pluginInstance.name === "plugin-env") continue; // Skip self

      const pluginWithEnvVars = pluginInstance as PluginWithEnvVars;
      const declared = pluginWithEnvVars.declaredEnvVars;

      if (declared) {
        logger.debug(
          `[EnvManager] Found declaredEnvVars for plugin: ${pluginInstance.name}`,
        );
        if (!this.envVarCache[pluginInstance.name]) {
          this.envVarCache[pluginInstance.name] = {};
        }

        for (const [varName, declaration] of Object.entries(declared)) {
          if (!this.envVarCache[pluginInstance.name][varName]) {
            const settingKey = `ENV_${varName}`;
            const currentValue =
              this.runtime.getSetting(settingKey) || declaration.defaultValue;
            const inferredType =
              declaration.type || this.inferVariableType(varName);

            this.envVarCache[pluginInstance.name][varName] = {
              type: inferredType,
              required:
                declaration.required !== undefined
                  ? declaration.required
                  : true,
              description:
                declaration.description ||
                `${varName} for ${pluginInstance.name}`,
              canGenerate:
                declaration.canGenerate !== undefined
                  ? declaration.canGenerate
                  : canGenerateEnvVar(
                      varName,
                      inferredType,
                      declaration.description,
                    ),
              status: currentValue ? "valid" : "missing",
              attempts: 0,
              plugin: pluginInstance.name,
              createdAt: Date.now(),
              value: currentValue,
              validatedAt: currentValue ? Date.now() : undefined,
              validationMethod: declaration.validationMethod,
              lastError: undefined,
            };

            if (currentValue) {
              this.runtime.setSetting(settingKey, currentValue);
            }

            logger.debug(
              `[EnvManager] Registered requirement for ${varName} from ${pluginInstance.name}`,
            );
          }
        }
      }
    }
  }

  /**
   * Infer the type of an environment variable from its name
   */
  private inferVariableType(varName: string): EnvVarConfig["type"] {
    const lowerName = varName.toLowerCase();

    if (lowerName.includes("api_key") || lowerName.includes("token")) {
      return "api_key";
    } else if (lowerName.includes("private_key")) {
      return "private_key";
    } else if (lowerName.includes("public_key")) {
      return "public_key";
    } else if (lowerName.includes("url") || lowerName.includes("endpoint")) {
      return "url";
    } else if (lowerName.includes("secret") || lowerName.includes("key")) {
      return "secret";
    } else {
      return "config";
    }
  }

  /**
   * Get environment variables for a specific plugin
   */
  async getEnvVarsForPlugin(
    pluginName: string,
  ): Promise<Record<string, EnvVarConfig> | null> {
    try {
      return this.envVarCache[pluginName] || null;
    } catch (error) {
      logger.error(
        `[EnvManager] Error getting env vars for plugin ${pluginName}:`,
        error,
      );
      return null;
    }
  }

  /**
   * Get all environment variables
   */
  async getAllEnvVars(): Promise<EnvVarMetadata | null> {
    try {
      return this.envVarCache;
    } catch (error) {
      logger.error("[EnvManager] Error getting all env vars:", error);
      return null;
    }
  }

  /**
   * Update an environment variable
   */
  async updateEnvVar(
    pluginName: string,
    varName: string,
    updates: Partial<EnvVarConfig>,
  ): Promise<boolean> {
    try {
      if (!this.envVarCache[pluginName]) {
        this.envVarCache[pluginName] = {};
      }

      // Get current config
      const currentConfig = this.envVarCache[pluginName][varName] || {
        type: "config" as const,
        required: false,
        description: "",
        canGenerate: false,
        status: "missing" as const,
        attempts: 0,
        plugin: pluginName,
        createdAt: Date.now(),
      };

      // Check for duplicate value
      if (
        updates.value !== undefined &&
        currentConfig.value === updates.value &&
        currentConfig.status === "valid"
      ) {
        logger.info(`[EnvManager] Skipping duplicate value for ${varName}`);
        return true; // Consider it successful but don't update
      }

      // Update the environment variable
      this.envVarCache[pluginName][varName] = {
        ...currentConfig,
        ...updates,
      };

      // Update runtime setting if value was set
      if (updates.value !== undefined) {
        const settingKey = `ENV_${varName}`;
        this.runtime.setSetting(settingKey, updates.value);
        logger.info(
          `[EnvManager] Updated environment variable ${varName} for plugin ${pluginName}`,
        );
      }

      // Save to character secrets
      await this.saveEnvVarsToSecrets();

      return true;
    } catch (error) {
      logger.error(`[EnvManager] Error updating env var ${varName}:`, error);
      return false;
    }
  }

  /**
   * Get the value of an environment variable from runtime settings
   */
  getEnvVar(varName: string): string | null {
    const settingKey = `ENV_${varName}`;
    return (this.runtime.getSetting(settingKey) as string) || null;
  }

  /**
   * Check if there are missing environment variables
   */
  async hasMissingEnvVars(): Promise<boolean> {
    for (const plugin of Object.values(this.envVarCache)) {
      for (const config of Object.values(plugin)) {
        if (config.required && config.status === "missing") {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Get missing environment variables
   */
  async getMissingEnvVars(): Promise<
    Array<{ plugin: string; varName: string; config: EnvVarConfig }>
  > {
    const missing: Array<{
      plugin: string;
      varName: string;
      config: EnvVarConfig;
    }> = [];

    for (const [pluginName, plugin] of Object.entries(this.envVarCache)) {
      for (const [varName, config] of Object.entries(plugin)) {
        if (config.required && config.status === "missing") {
          missing.push({ plugin: pluginName, varName, config });
        }
      }
    }

    return missing;
  }

  /**
   * Get generatable environment variables
   */
  async getGeneratableEnvVars(): Promise<
    Array<{ plugin: string; varName: string; config: EnvVarConfig }>
  > {
    const missing = await this.getMissingEnvVars();
    return missing.filter(({ config }) => config.canGenerate);
  }

  /**
   * Stop the service
   */
  async stop(): Promise<void> {
    // Save any pending changes
    await this.saveEnvVarsToSecrets();
    logger.info("[EnvManager] Environment Manager Service stopped");
  }

  /**
   * Static method to stop the service
   */
  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService("ENV_MANAGER") as EnvManagerService;
    if (service) {
      await service.stop();
    }
  }
}
