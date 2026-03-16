import {
  logger,
  Service,
  type IAgentRuntime,
  type UUID,
  type Component,
  Role,
  createUniqueUuid,
} from "@elizaos/core";
import { EnvManagerService } from "./service";
import type {
  SecretConfig,
  SecretContext,
  SecretMetadata,
  SecretPermission,
  SecretPermissionType,
  EncryptedSecret,
  SecretAccessLog,
  ValidationResult,
} from "./types";
import { validateEnvVar } from "./validation";
import {
  createHash,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "crypto";

/**
 * Shape of data stored in secret components
 */
interface SecretComponentData {
  key: string;
  value?: string | EncryptedSecret;
  metadata?: SecretMetadata & { encrypted?: boolean };
  encrypted?: boolean;
}

/**
 * Enhanced Secret Manager Service for multi-level secret management
 * Extends the existing EnvManagerService to maintain backward compatibility
 */
export class EnhancedSecretManager extends EnvManagerService {
  static serviceType = "SECRETS";
  capabilityDescription =
    "The agent can manage secrets and settings at global, world, and user levels with encryption and access control";

  private secretCache: Map<string, SecretMetadata> = new Map();
  private encryptionKey: Buffer;
  private accessLogs: SecretAccessLog[] = [];

  /**
   * Start the Enhanced Secret Manager Service
   */
  static async start(runtime: IAgentRuntime): Promise<EnhancedSecretManager> {
    const service = new EnhancedSecretManager(runtime);
    await service.initialize();
    return service;
  }

  /**
   * Initialize the enhanced service
   */
  async initialize(): Promise<void> {
    // Initialize parent service
    await super.initialize();

    logger.info("[SecretManager] Initializing Enhanced Secret Manager Service");

    // Initialize encryption key (in production, this should come from a secure key management service)
    this.initializeEncryption();

    // Load existing secrets from various sources
    await this.loadAllSecrets();
  }

  /**
   * Initialize encryption key
   */
  private initializeEncryption(): void {
    // In production, use a proper key management service
    // For now, derive from agent ID + salt
    const salt = this.runtime.getSetting("ENCRYPTION_SALT") || "default-salt";
    this.encryptionKey = createHash("sha256")
      .update(this.runtime.agentId + salt)
      .digest();
  }

  /**
   * Load all secrets from various storage locations
   */
  private async loadAllSecrets(): Promise<void> {
    // Load global secrets from character settings
    await this.loadGlobalSecrets();

    // Load world secrets from world metadata
    await this.loadWorldSecrets();

    // User secrets are loaded on-demand from components
  }

  /**
   * Load global secrets from character settings
   */
  private async loadGlobalSecrets(): Promise<void> {
    try {
      const globalMeta: SecretMetadata = {};

      // Convert existing env vars to secret format
      const envVars = await this.getAllEnvVars();
      if (envVars) {
        for (const [plugin, vars] of Object.entries(envVars)) {
          for (const [key, config] of Object.entries(vars)) {
            globalMeta[key] = {
              ...config,
              level: "global",
              encrypted: false,
            };
          }
        }
      }

      this.secretCache.set("global", globalMeta);
    } catch (error) {
      logger.error("[SecretManager] Error loading global secrets:", error);
    }
  }

  /**
   * Load world secrets from world metadata
   */
  private async loadWorldSecrets(): Promise<void> {
    try {
      // Get all worlds for this agent
      const worlds = await this.runtime.db.getWorlds(this.runtime.agentId);

      for (const world of worlds) {
        if (world.metadata?.secrets) {
          const worldMeta: SecretMetadata = {};

          for (const [key, value] of Object.entries(world.metadata.secrets)) {
            worldMeta[key] = value as SecretConfig;
          }

          this.secretCache.set(`world:${world.id}`, worldMeta);
        }
      }
    } catch (error) {
      logger.error("[SecretManager] Error loading world secrets:", error);
    }
  }

  /**
   * Get a secret value with context-aware access control
   */
  async get(key: string, context: SecretContext): Promise<string | null> {
    try {
      // Log access attempt
      await this.logAccess(key, "read", context, true);

      // Check permissions
      if (!(await this.checkPermission(key, "read", context))) {
        await this.logAccess(key, "read", context, false, "Permission denied");
        return null;
      }

      // Get secret based on context level
      switch (context.level) {
        case "global":
          return await this.getGlobalSecret(key);

        case "world":
          if (!context.worldId)
            throw new Error("World ID required for world-level secrets");
          return await this.getWorldSecret(key, context.worldId);

        case "user":
          if (!context.userId)
            throw new Error("User ID required for user-level secrets");
          return await this.getUserSecret(key, context.userId);

        default:
          throw new Error(`Invalid secret level: ${context.level}`);
      }
    } catch (error) {
      logger.error(`[SecretManager] Error getting secret ${key}:`, error);
      await this.logAccess(key, "read", context, false, error.message);
      return null;
    }
  }

  /**
   * Set a secret value with context-aware access control
   */
  async set(
    key: string,
    value: any,
    context: SecretContext,
    config?: Partial<SecretConfig>,
  ): Promise<boolean> {
    try {
      // Log access attempt
      await this.logAccess(key, "write", context, true);

      // Check permissions
      if (!(await this.checkPermission(key, "write", context))) {
        await this.logAccess(key, "write", context, false, "Permission denied");
        return false;
      }

      // Validate value if config specifies
      if (config?.validationMethod || config?.type) {
        const validation = await validateEnvVar(
          key,
          value,
          config.type || "secret",
          config.validationMethod,
        );

        if (!validation.isValid) {
          throw new Error(`Validation failed: ${validation.error}`);
        }
      }

      // Create full config
      const fullConfig: SecretConfig = {
        value,
        type: config?.type || "secret",
        required: config?.required ?? false,
        description: config?.description || `Secret: ${key}`,
        canGenerate: false,
        status: "valid",
        attempts: 0,
        plugin: config?.plugin || context.level,
        level: context.level,
        ownerId: context.userId,
        worldId: context.worldId,
        encrypted: config?.encrypted ?? true,
        permissions: config?.permissions,
        createdAt: Date.now(),
        validatedAt: Date.now(),
      };

      // Set secret based on context level
      switch (context.level) {
        case "global":
          return await this.setGlobalSecret(key, value, fullConfig);

        case "world":
          if (!context.worldId)
            throw new Error("World ID required for world-level secrets");
          return await this.setWorldSecret(
            key,
            value,
            context.worldId,
            fullConfig,
          );

        case "user":
          if (!context.userId)
            throw new Error("User ID required for user-level secrets");
          return await this.setUserSecret(
            key,
            value,
            context.userId,
            fullConfig,
          );

        default:
          throw new Error(`Invalid secret level: ${context.level}`);
      }
    } catch (error) {
      logger.error(`[SecretManager] Error setting secret ${key}:`, error);
      await this.logAccess(key, "write", context, false, error.message);
      return false;
    }
  }

  /**
   * Get global secret
   */
  private async getGlobalSecret(key: string): Promise<string | null> {
    // First try the env var approach for backward compatibility
    const envValue = this.getEnvVar(key);
    if (envValue) return envValue;

    // Then check our cache
    const globalSecrets = this.secretCache.get("global");
    const config = globalSecrets?.[key];

    return config?.value || null;
  }

  /**
   * Set global secret
   */
  private async setGlobalSecret(
    key: string,
    value: any,
    config: SecretConfig,
  ): Promise<boolean> {
    // Set in parent service for backward compatibility
    const envKey = key.startsWith("ENV_") ? key.substring(4) : key;
    await this.updateEnvVar(config.plugin || "global", envKey, {
      ...config,
      value,
    });

    // Update our cache
    const globalSecrets = this.secretCache.get("global") || {};
    globalSecrets[key] = config;
    this.secretCache.set("global", globalSecrets);

    return true;
  }

  /**
   * Get world secret
   */
  private async getWorldSecret(
    key: string,
    worldId: string,
  ): Promise<string | null> {
    // Check cache first
    const worldSecrets = this.secretCache.get(`world:${worldId}`);
    if (worldSecrets?.[key]) {
      const config = worldSecrets[key];
      if (config.encrypted && config.value) {
        return await this.decrypt(config.value);
      }
      return config.value || null;
    }

    // Load from world metadata
    const world = await this.runtime.getWorld(worldId as UUID);
    if (world?.metadata?.secrets?.[key]) {
      const secretData = world.metadata.secrets[key];
      if (typeof secretData === "object" && secretData.encrypted) {
        return await this.decrypt(secretData.value);
      }
      return secretData.value || secretData;
    }

    return null;
  }

  /**
   * Set world secret
   */
  private async setWorldSecret(
    key: string,
    value: any,
    worldId: string,
    config: SecretConfig,
  ): Promise<boolean> {
    const world = await this.runtime.getWorld(worldId as UUID);
    if (!world) {
      throw new Error(`World ${worldId} not found`);
    }

    // Initialize metadata structures
    if (!world.metadata) world.metadata = {};
    if (!world.metadata.secrets) world.metadata.secrets = {};

    // Encrypt if needed
    const finalValue = config.encrypted ? await this.encrypt(value) : value;

    // Store in world metadata
    world.metadata.secrets[key] = {
      ...config,
      value: finalValue,
    };

    // Update world
    await this.runtime.updateWorld(world);

    // Update cache
    const worldSecrets = this.secretCache.get(`world:${worldId}`) || {};
    worldSecrets[key] = { ...config, value: finalValue };
    this.secretCache.set(`world:${worldId}`, worldSecrets);

    return true;
  }

  /**
   * Get user secret from components
   */
  private async getUserSecret(
    key: string,
    userId: string,
  ): Promise<string | null> {
    const components = await this.runtime.getComponents(userId as UUID);

    logger.debug(
      `[SecretManager] getUserSecret: Found ${components.length} components for user ${userId}`,
    );

    const secretComponent = components.find(
      (c) => c.data?.key === key && c.type === "secret",
    );
    if (!secretComponent) {
      logger.debug(
        `[SecretManager] getUserSecret: No component found with key ${key}`,
      );
      return null;
    }

    logger.debug(
      `[SecretManager] getUserSecret: Found component with data:`,
      secretComponent.data,
    );

    const secretData = secretComponent.data as SecretComponentData;

    // Check if the value is an encrypted object
    if (
      secretData.metadata?.encrypted &&
      secretData.value &&
      typeof secretData.value === "object" &&
      (secretData.value as EncryptedSecret).algorithm
    ) {
      return await this.decrypt(secretData.value as EncryptedSecret);
    }

    // For backward compatibility, check old structure
    if (secretData.encrypted && secretData.value) {
      return await this.decrypt(secretData.value as EncryptedSecret);
    }

    return (secretData.value as string | undefined) || null;
  }

  /**
   * Set user secret as component
   */
  private async setUserSecret(
    key: string,
    value: any,
    userId: string,
    config: SecretConfig,
  ): Promise<boolean> {
    logger.debug(
      `[SecretManager] setUserSecret: Storing ${key} for user ${userId}`,
    );

    const existingComponents = await this.runtime.getComponents(userId as UUID);

    const existingComponent = existingComponents.find(
      (c) => c.data?.key === key && c.type === "secret",
    );

    const finalValue = config.encrypted ? await this.encrypt(value) : value;

    const componentData = {
      key,
      value: finalValue,
      metadata: config,
      updatedAt: Date.now(),
    };

    logger.debug(
      `[SecretManager] setUserSecret: Component data:`,
      componentData,
    );

    if (existingComponent) {
      await this.runtime.updateComponent({
        ...existingComponent,
        data: componentData,
      });
    } else {
      const newComponent: Component = {
        id: createUniqueUuid(this.runtime, `${userId}-${key}`),
        createdAt: Date.now(),
        entityId: userId as UUID,
        agentId: this.runtime.agentId,
        roomId: this.runtime.agentId,
        worldId: this.runtime.agentId,
        sourceEntityId: userId as UUID,
        type: "secret",
        data: componentData,
      };
      logger.debug(
        `[SecretManager] setUserSecret: Creating new component:`,
        newComponent,
      );
      await this.runtime.createComponent(newComponent);
    }

    return true;
  }

  /**
   * List secrets at a specific level
   */
  async list(context: SecretContext): Promise<SecretMetadata> {
    const filteredSecrets: SecretMetadata = {};

    switch (context.level) {
      case "global":
        const globalSecrets = this.secretCache.get("global") || {};
        // Filter out sensitive values
        for (const [key, config] of Object.entries(globalSecrets)) {
          filteredSecrets[key] = { ...config, value: undefined };
        }
        break;

      case "world":
        if (!context.worldId) throw new Error("World ID required");
        const worldSecrets =
          this.secretCache.get(`world:${context.worldId}`) || {};
        for (const [key, config] of Object.entries(worldSecrets)) {
          filteredSecrets[key] = { ...config, value: undefined };
        }
        break;

      case "user":
        if (!context.userId) throw new Error("User ID required");
        const components = await this.runtime.getComponents(
          context.userId as UUID,
        );

        for (const component of components) {
          if (component.type === "secret") {
            const data = component.data as SecretComponentData;
            filteredSecrets[data.key] = { ...data.metadata, value: undefined };
          }
        }
        break;
    }

    return filteredSecrets;
  }

  /**
   * Check permission for secret access
   */
  private async checkPermission(
    key: string,
    action: "read" | "write" | "delete" | "share",
    context: SecretContext,
  ): Promise<boolean> {
    // Global secrets - only agent admin can write
    if (context.level === "global") {
      if (action === "read") return true; // All can read global secrets
      return context.requesterId === this.runtime.agentId; // Only agent can write
    }

    // World secrets - check world roles
    if (context.level === "world" && context.worldId) {
      const world = await this.runtime.getWorld(context.worldId as UUID);
      if (!world) return false;

      const requesterRole =
        world.metadata?.roles?.[context.requesterId || ""] || Role.NONE;

      if (action === "read") {
        return true; // All world members can read
      }

      // Only OWNER and ADMIN can write/delete/share
      return requesterRole === Role.OWNER || requesterRole === Role.ADMIN;
    }

    // User secrets - only the user themselves can access
    if (context.level === "user" && context.userId) {
      return context.requesterId === context.userId;
    }

    return false;
  }

  /**
   * Grant access to a secret
   */
  async grantAccess(
    key: string,
    context: SecretContext,
    grantee: string,
    permissions: SecretPermissionType[],
  ): Promise<boolean> {
    if (!(await this.checkPermission(key, "share", context))) {
      return false;
    }

    // Get current config
    const config = await this.getSecretConfig(key, context);
    if (!config) return false;

    // Add permission
    const newPermission: SecretPermission = {
      entityId: grantee,
      permissions,
      grantedBy: context.requesterId || context.userId || this.runtime.agentId,
      grantedAt: Date.now(),
    };

    config.permissions = config.permissions || [];
    config.permissions.push(newPermission);
    config.sharedWith = config.sharedWith || [];
    if (!config.sharedWith.includes(grantee)) {
      config.sharedWith.push(grantee);
    }

    // Update secret config
    return await this.updateSecretConfig(key, context, config);
  }

  /**
   * Revoke access to a secret
   */
  async revokeAccess(
    key: string,
    context: SecretContext,
    grantee: string,
  ): Promise<boolean> {
    if (!(await this.checkPermission(key, "share", context))) {
      return false;
    }

    // Get current config
    const config = await this.getSecretConfig(key, context);
    if (!config) return false;

    // Remove permissions
    config.permissions = (config.permissions || []).filter(
      (p) => p.entityId !== grantee,
    );
    config.sharedWith = (config.sharedWith || []).filter(
      (id) => id !== grantee,
    );

    // Update secret config
    return await this.updateSecretConfig(key, context, config);
  }

  /**
   * Get secret config without value
   */
  private async getSecretConfig(
    key: string,
    context: SecretContext,
  ): Promise<SecretConfig | null> {
    const metadata = await this.list(context);
    return metadata[key] || null;
  }

  /**
   * Update secret config
   */
  private async updateSecretConfig(
    key: string,
    context: SecretContext,
    config: SecretConfig,
  ): Promise<boolean> {
    // Get current value
    const currentValue = await this.get(key, context);
    if (currentValue === null) return false;

    // Set with updated config
    return await this.set(key, currentValue, context, config);
  }

  /**
   * Encrypt a value
   */
  private async encrypt(value: string): Promise<EncryptedSecret> {
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);

    let encrypted = cipher.update(value, "utf8", "base64");
    encrypted += cipher.final("base64");

    const authTag = cipher.getAuthTag();

    return {
      value: encrypted,
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
      algorithm: "aes-256-gcm",
      keyId: "default",
    };
  }

  /**
   * Decrypt a value
   */
  private async decrypt(
    encryptedData: EncryptedSecret | string,
  ): Promise<string> {
    if (typeof encryptedData === "string") {
      // Backward compatibility - not encrypted
      return encryptedData;
    }

    const iv = Buffer.from(encryptedData.iv, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, iv);

    if (encryptedData.authTag) {
      decipher.setAuthTag(Buffer.from(encryptedData.authTag, "base64"));
    }

    let decrypted = decipher.update(encryptedData.value, "base64", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  }

  /**
   * Log access attempt
   */
  private async logAccess(
    key: string,
    action: "read" | "write" | "delete" | "share",
    context: SecretContext,
    success: boolean,
    error?: string,
  ): Promise<void> {
    const log: SecretAccessLog = {
      secretKey: key,
      accessedBy: context.requesterId || context.userId || this.runtime.agentId,
      action,
      timestamp: Date.now(),
      context,
      success,
      error,
    };

    this.accessLogs.push(log);

    // Keep only last 1000 logs in memory
    if (this.accessLogs.length > 1000) {
      this.accessLogs = this.accessLogs.slice(-1000);
    }

    logger.debug(`[SecretManager] Access log: ${JSON.stringify(log)}`);
  }

  /**
   * Get access logs for a secret
   */
  async getAccessLogs(
    key: string,
    context?: SecretContext,
  ): Promise<SecretAccessLog[]> {
    return this.accessLogs.filter((log) => {
      if (log.secretKey !== key) return false;
      if (context) {
        if (context.level && log.context.level !== context.level) return false;
        if (context.worldId && log.context.worldId !== context.worldId)
          return false;
        if (context.userId && log.context.userId !== context.userId)
          return false;
      }
      return true;
    });
  }

  /**
   * Migrate world settings to secrets
   */
  async migrateWorldSettings(worldId: string): Promise<void> {
    logger.info(`[SecretManager] Migrating world settings for ${worldId}`);

    const world = await this.runtime.getWorld(worldId as UUID);
    if (!world?.metadata?.settings) return;

    const settings = world.metadata.settings;
    let migrated = 0;

    for (const [key, setting] of Object.entries(settings)) {
      if (setting && typeof setting === "object" && setting.secret) {
        // Migrate secret setting to secret storage
        const context: SecretContext = {
          level: "world",
          worldId,
          agentId: this.runtime.agentId,
        };

        const config: Partial<SecretConfig> = {
          type: "secret",
          required: setting.required,
          description: setting.description,
          encrypted: true,
        };

        if (await this.set(key, setting.value, context, config)) {
          // Remove from settings
          delete settings[key];
          migrated++;
        }
      }
    }

    if (migrated > 0) {
      // Update world without the migrated secrets
      world.metadata.settings = settings;
      await this.runtime.updateWorld(world);
      logger.info(
        `[SecretManager] Migrated ${migrated} secrets for world ${worldId}`,
      );
    }
  }

  /**
   * Check if an entity has access to a secret
   */
  async checkAccess(
    key: string,
    context: SecretContext,
    accessCheck: {
      actionId?: string;
      entityId?: string;
      permission: SecretPermissionType;
    },
  ): Promise<boolean> {
    // Get secret config to check permissions
    const config = await this.getSecretConfig(key, context);
    if (!config || !config.permissions) return false;

    // Check if the entity has the required permission
    const entityId = accessCheck.entityId || accessCheck.actionId;
    if (!entityId) return false;

    const entityPermission = config.permissions.find(
      (p) => p.entityId === entityId,
    );
    if (!entityPermission) return false;

    return entityPermission.permissions.includes(accessCheck.permission);
  }

  /**
   * Stop the service
   */
  async stop(): Promise<void> {
    // Clear sensitive data
    this.secretCache.clear();
    this.accessLogs = [];

    logger.info("[SecretManager] Enhanced Secret Manager Service stopped");
  }
}
