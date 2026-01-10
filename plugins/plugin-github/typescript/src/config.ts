/**
 * GitHub plugin configuration.
 *
 * Configuration can be loaded from environment variables or runtime settings.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { z, ZodError } from "zod";
import { ConfigError, MissingSettingError } from "./error";
import type { GitHubSettings } from "./types";

/**
 * GitHub configuration schema
 */
const configSchema = z.object({
  apiToken: z.string().min(1, "API token is required"),
  owner: z.string().optional(),
  repo: z.string().optional(),
  branch: z.string().default("main"),
  webhookSecret: z.string().optional(),
  appId: z.string().optional(),
  appPrivateKey: z.string().optional(),
  installationId: z.string().optional(),
});

export type GitHubConfig = z.infer<typeof configSchema>;

/**
 * GitHub plugin configuration class.
 *
 * Provides typed access to GitHub settings with validation.
 */
export class GitHubPluginConfig {
  public readonly apiToken: string;
  public readonly owner: string | undefined;
  public readonly repo: string | undefined;
  public readonly branch: string;
  public readonly webhookSecret: string | undefined;
  public readonly appId: string | undefined;
  public readonly appPrivateKey: string | undefined;
  public readonly installationId: string | undefined;

  private constructor(config: GitHubConfig) {
    this.apiToken = config.apiToken;
    this.owner = config.owner;
    this.repo = config.repo;
    this.branch = config.branch;
    this.webhookSecret = config.webhookSecret;
    this.appId = config.appId;
    this.appPrivateKey = config.appPrivateKey;
    this.installationId = config.installationId;
  }

  /**
   * Create configuration from runtime settings.
   *
   * @param runtime - The agent runtime
   * @returns Configuration instance
   * @throws MissingSettingError if required settings are missing
   * @throws ConfigError if configuration is invalid
   */
  static fromRuntime(runtime: IAgentRuntime): GitHubPluginConfig {
    const apiToken = runtime.getSetting("GITHUB_API_TOKEN");

    if (!apiToken) {
      throw new MissingSettingError("GITHUB_API_TOKEN");
    }

    const rawConfig = {
      apiToken,
      owner: runtime.getSetting("GITHUB_OWNER") ?? undefined,
      repo: runtime.getSetting("GITHUB_REPO") ?? undefined,
      branch: runtime.getSetting("GITHUB_BRANCH") ?? "main",
      webhookSecret: runtime.getSetting("GITHUB_WEBHOOK_SECRET") ?? undefined,
      appId: runtime.getSetting("GITHUB_APP_ID") ?? undefined,
      appPrivateKey: runtime.getSetting("GITHUB_APP_PRIVATE_KEY") ?? undefined,
      installationId: runtime.getSetting("GITHUB_INSTALLATION_ID") ?? undefined,
    };

    const result = configSchema.safeParse(rawConfig);

    if (!result.success) {
      const formattedErrors = result.error.format();
      const errorMessages = Object.entries(formattedErrors)
        .filter(([key]) => key !== '_errors')
        .map(([key, value]) => `${key}: ${(value as { _errors?: string[] })?._errors?.join(', ') ?? 'invalid'}`)
        .join(', ');
      throw new ConfigError(errorMessages || 'Invalid configuration');
    }

    return new GitHubPluginConfig(result.data);
  }

  /**
   * Create configuration from settings object.
   *
   * @param settings - GitHub settings
   * @returns Configuration instance
   * @throws ConfigError if configuration is invalid
   */
  static fromSettings(settings: GitHubSettings): GitHubPluginConfig {
    const result = configSchema.safeParse({
      ...settings,
      branch: settings.branch ?? "main",
    });

    if (!result.success) {
      const formattedErrors = result.error.format();
      const errorMessages = Object.entries(formattedErrors)
        .filter(([key]) => key !== '_errors')
        .map(([key, value]) => `${key}: ${(value as { _errors?: string[] })?._errors?.join(', ') ?? 'invalid'}`)
        .join(', ');
      throw new ConfigError(errorMessages || 'Invalid configuration');
    }

    return new GitHubPluginConfig(result.data);
  }

  /**
   * Create configuration from environment variables.
   *
   * @returns Configuration instance
   * @throws MissingSettingError if required variables are missing
   * @throws ConfigError if configuration is invalid
   */
  static fromEnv(): GitHubPluginConfig {
    const apiToken = process.env["GITHUB_API_TOKEN"];

    if (!apiToken) {
      throw new MissingSettingError("GITHUB_API_TOKEN");
    }

    const rawConfig = {
      apiToken,
      owner: process.env["GITHUB_OWNER"],
      repo: process.env["GITHUB_REPO"],
      branch: process.env["GITHUB_BRANCH"] ?? "main",
      webhookSecret: process.env["GITHUB_WEBHOOK_SECRET"],
      appId: process.env["GITHUB_APP_ID"],
      appPrivateKey: process.env["GITHUB_APP_PRIVATE_KEY"],
      installationId: process.env["GITHUB_INSTALLATION_ID"],
    };

    const result = configSchema.safeParse(rawConfig);

    if (!result.success) {
      const formattedErrors = result.error.format();
      const errorMessages = Object.entries(formattedErrors)
        .filter(([key]) => key !== '_errors')
        .map(([key, value]) => `${key}: ${(value as { _errors?: string[] })?._errors?.join(', ') ?? 'invalid'}`)
        .join(', ');
      throw new ConfigError(errorMessages || 'Invalid configuration');
    }

    return new GitHubPluginConfig(result.data);
  }

  /**
   * Get repository reference, falling back to defaults.
   *
   * @param owner - Optional owner override
   * @param repo - Optional repo override
   * @returns Repository reference
   * @throws MissingSettingError if neither override nor default is available
   */
  getRepositoryRef(
    owner?: string,
    repo?: string,
  ): { owner: string; repo: string } {
    const resolvedOwner = owner ?? this.owner;
    const resolvedRepo = repo ?? this.repo;

    if (!resolvedOwner) {
      throw new MissingSettingError("owner (GITHUB_OWNER)");
    }

    if (!resolvedRepo) {
      throw new MissingSettingError("repo (GITHUB_REPO)");
    }

    return { owner: resolvedOwner, repo: resolvedRepo };
  }

  /**
   * Check if GitHub App authentication is configured.
   */
  hasAppAuth(): boolean {
    return !!(this.appId && this.appPrivateKey);
  }

  /**
   * Validate the configuration.
   *
   * @throws ConfigError if configuration is invalid
   */
  validate(): void {
    if (!this.apiToken.startsWith("ghp_") && 
        !this.apiToken.startsWith("gho_") && 
        !this.apiToken.startsWith("ghu_") &&
        !this.apiToken.startsWith("ghs_") &&
        !this.apiToken.startsWith("ghr_") &&
        !this.apiToken.startsWith("github_pat_")) {
      // May be a fine-grained PAT or classic token
      // Just log a warning instead of throwing
      console.warn(
        "GitHub API token format not recognized. Ensure it is a valid token.",
      );
    }

    if (this.hasAppAuth() && !this.installationId) {
      throw new ConfigError(
        "GITHUB_INSTALLATION_ID is required when using GitHub App authentication",
      );
    }
  }

  /**
   * Convert to plain settings object.
   */
  toSettings(): GitHubSettings {
    return {
      apiToken: this.apiToken,
      owner: this.owner,
      repo: this.repo,
      branch: this.branch,
      webhookSecret: this.webhookSecret,
      appId: this.appId,
      appPrivateKey: this.appPrivateKey,
      installationId: this.installationId,
    };
  }
}

/**
 * Validate GitHub configuration from runtime.
 *
 * @param runtime - The agent runtime
 * @returns Validated configuration
 */
export function validateGitHubConfig(
  runtime: IAgentRuntime,
): GitHubPluginConfig {
  const config = GitHubPluginConfig.fromRuntime(runtime);
  config.validate();
  return config;
}

