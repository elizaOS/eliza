/**
 * @module github-service
 * @description Service that owns GitHub REST clients for the plugin.
 *
 * Two independent PATs are supported: a user-acting token and an
 * agent-acting token. Actions request the Octokit client they need via
 * `getOctokit(as)`; the service returns `null` when the requested identity
 * has no token configured (graceful degrade — the action reports a clean
 * error instead of crashing initialization).
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import { Octokit } from "@octokit/rest";
import {
  GITHUB_SERVICE_TYPE,
  type GitHubIdentity,
  type GitHubOctokitClient,
  type IGitHubService,
} from "../types.js";

interface TokenSources {
  user: string | undefined;
  agent: string | undefined;
}

function readTokens(runtime: IAgentRuntime): TokenSources {
  const setting = (key: string): string | undefined => {
    const value = runtime.getSetting(key);
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    return undefined;
  };

  return {
    user: setting("GITHUB_USER_PAT") ?? setting("MILADY_E2E_GITHUB_USER_PAT"),
    agent:
      setting("GITHUB_AGENT_PAT") ?? setting("MILADY_E2E_GITHUB_AGENT_PAT"),
  };
}

export class GitHubService extends Service implements IGitHubService {
  static serviceType = GITHUB_SERVICE_TYPE;
  capabilityDescription =
    "GitHub REST API integration for PRs, issues, and notifications";

  private userClient: GitHubOctokitClient | null = null;
  private agentClient: GitHubOctokitClient | null = null;

  constructor(
    runtime?: IAgentRuntime,
    private readonly createClient: (auth: string) => GitHubOctokitClient = (
      auth,
    ) => new Octokit({ auth }),
  ) {
    super(runtime);
  }

  static async start(
    runtime: IAgentRuntime,
    createClient?: (auth: string) => GitHubOctokitClient,
  ): Promise<Service> {
    const service = new GitHubService(runtime, createClient);
    service.initialize();
    return service;
  }

  private initialize(): void {
    if (!this.runtime) {
      return;
    }
    const tokens = readTokens(this.runtime);
    if (tokens.user) {
      this.userClient = this.createClient(tokens.user);
    } else {
      logger.info(
        "[GitHubService] GITHUB_USER_PAT not set — user-acting calls will be rejected",
      );
    }
    if (tokens.agent) {
      this.agentClient = this.createClient(tokens.agent);
    } else {
      logger.info(
        "[GitHubService] GITHUB_AGENT_PAT not set — agent-acting calls will be rejected",
      );
    }
  }

  getOctokit(as: GitHubIdentity): GitHubOctokitClient | null {
    return as === "user" ? this.userClient : this.agentClient;
  }

  /**
   * Allows tests to inject an Octokit-shaped mock without going through
   * environment variables. Not part of the public runtime contract.
   */
  setClientForTesting(
    as: GitHubIdentity,
    client: GitHubOctokitClient | null,
  ): void {
    if (as === "user") {
      this.userClient = client;
    } else {
      this.agentClient = client;
    }
  }

  async stop(): Promise<void> {
    this.userClient = null;
    this.agentClient = null;
  }
}
