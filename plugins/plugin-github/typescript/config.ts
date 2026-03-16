import type { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";
import { ConfigError, MissingSettingError } from "./error";
import { formatZodErrors, type GitHubSettings } from "./types";

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
      throw new ConfigError(formatZodErrors(result.error));
    }

    return new GitHubPluginConfig(result.data);
  }

  static fromSettings(settings: GitHubSettings): GitHubPluginConfig {
    const result = configSchema.safeParse({
      ...settings,
      branch: settings.branch ?? "main",
    });

    if (!result.success) {
      throw new ConfigError(formatZodErrors(result.error));
    }

    return new GitHubPluginConfig(result.data);
  }

  static fromEnv(): GitHubPluginConfig {
    const apiToken = process.env.GITHUB_API_TOKEN;

    if (!apiToken) {
      throw new MissingSettingError("GITHUB_API_TOKEN");
    }

    const rawConfig = {
      apiToken,
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      branch: process.env.GITHUB_BRANCH ?? "main",
      webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
      appId: process.env.GITHUB_APP_ID,
      appPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY,
      installationId: process.env.GITHUB_INSTALLATION_ID,
    };

    const result = configSchema.safeParse(rawConfig);

    if (!result.success) {
      throw new ConfigError(formatZodErrors(result.error));
    }

    return new GitHubPluginConfig(result.data);
  }

  getRepositoryRef(owner?: string, repo?: string): { owner: string; repo: string } {
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

  hasAppAuth(): boolean {
    return !!(this.appId && this.appPrivateKey);
  }

  validate(): void {
    if (
      !this.apiToken.startsWith("ghp_") &&
      !this.apiToken.startsWith("gho_") &&
      !this.apiToken.startsWith("ghu_") &&
      !this.apiToken.startsWith("ghs_") &&
      !this.apiToken.startsWith("ghr_") &&
      !this.apiToken.startsWith("github_pat_")
    ) {
      console.warn("GitHub API token format not recognized. Ensure it is a valid token.");
    }

    if (this.hasAppAuth() && !this.installationId) {
      throw new ConfigError(
        "GITHUB_INSTALLATION_ID is required when using GitHub App authentication"
      );
    }
  }

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

export function validateGitHubConfig(runtime: IAgentRuntime): GitHubPluginConfig {
  const config = GitHubPluginConfig.fromRuntime(runtime);
  config.validate();
  return config;
}
