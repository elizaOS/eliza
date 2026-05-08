/**
 * @module github-service
 * @description Service that owns GitHub REST clients for the plugin.
 *
 * Role-tagged account records are supported, with the legacy user/agent PAT
 * split preserved as the default account set. Actions request an Octokit
 * client by role and optionally by accountId; the service returns `null` when
 * the requested account has no token configured.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import { Octokit } from "@octokit/rest";
import {
  defaultGitHubAccountIdForRole,
  readGitHubAccountsWithConnectorCredentials,
  resolveGitHubAccount,
  type GitHubAccountConfig,
  type GitHubAccountSelection,
} from "../accounts.js";
import {
  GITHUB_SERVICE_TYPE,
  type GitHubIdentity,
  type GitHubOctokitClient,
  type IGitHubService,
} from "../types.js";

interface GitHubClientRecord {
  account: GitHubAccountConfig;
  client: GitHubOctokitClient;
}

function normalizeSelector(
  selector:
    | GitHubIdentity
    | { as?: GitHubIdentity; role?: GitHubIdentity; accountId?: string },
): GitHubAccountSelection {
  if (selector === "user" || selector === "agent") {
    return { role: selector };
  }
  return {
    accountId:
      typeof selector.accountId === "string" && selector.accountId.trim()
        ? selector.accountId.trim()
        : undefined,
    role: selector.role ?? selector.as ?? "agent",
  };
}

export class GitHubService extends Service implements IGitHubService {
  static serviceType = GITHUB_SERVICE_TYPE;
  capabilityDescription =
    "GitHub REST API integration for PRs, issues, and notifications";

  private clients = new Map<string, GitHubClientRecord>();

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
    await service.initialize();
    return service;
  }

  private async initialize(): Promise<void> {
    if (!this.runtime) {
      return;
    }
    const accounts = await readGitHubAccountsWithConnectorCredentials(this.runtime);
    this.clients.clear();
    for (const account of accounts) {
      this.clients.set(account.accountId, {
        account,
        client: this.createClient(account.token),
      });
    }
    for (const role of ["user", "agent"] as const) {
      if (!resolveGitHubAccount(accounts, { role })) {
        logger.info(
          `[GitHubService] no GitHub ${role} account configured — ${role}-acting calls will be rejected`,
        );
      }
    }
    logger.info(
      `[GitHubService] configured ${this.clients.size} GitHub account(s)`,
    );
  }

  getOctokit(
    selector:
      | GitHubIdentity
      | { as?: GitHubIdentity; role?: GitHubIdentity; accountId?: string },
  ): GitHubOctokitClient | null {
    const selection = normalizeSelector(selector);
    const account = resolveGitHubAccount(
      Array.from(this.clients.values()).map((record) => record.account),
      selection,
    );
    if (!account) {
      return null;
    }
    return this.clients.get(account.accountId)?.client ?? null;
  }

  /**
   * Allows tests to inject an Octokit-shaped mock without going through
   * environment variables. Not part of the public runtime contract.
   */
  setClientForTesting(
    as: GitHubIdentity,
    client: GitHubOctokitClient | null,
    accountId = defaultGitHubAccountIdForRole(as),
  ): void {
    if (!client) {
      this.clients.delete(accountId);
      return;
    }
    this.clients.set(accountId, {
      account: { accountId, role: as, token: "test" },
      client,
    });
  }

  async stop(): Promise<void> {
    this.clients.clear();
  }
}
