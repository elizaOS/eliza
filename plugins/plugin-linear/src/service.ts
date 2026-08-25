/**
 * Owns Linear credential resolution and delegates read operations to the
 * bounded GraphQL client. Local BYO mode reads LINEAR_API_KEY, managed mode
 * reads LINEAR_OAUTH_TOKEN; when neither is configured every operation fails
 * with a typed LINEAR_NOT_CONFIGURED error — there is no silent fallback and
 * no fabricated-empty result. Tests may inject a prebuilt client.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { Service } from "@elizaos/core";
import { LinearClient, type LinearCredential } from "./client.js";
import { LinearError } from "./errors.js";
import type {
  IssueSearchRequest,
  LinearIssue,
  LinearIssuePage,
  LinearTeamPage,
  LinearViewer,
  TeamListRequest,
} from "./types.js";

export const LINEAR_SERVICE_TYPE = "linear";

export class LinearService extends Service {
  static override readonly serviceType = LINEAR_SERVICE_TYPE;
  override capabilityDescription =
    "Read-only Linear issues, teams, and workspace identity over the Linear GraphQL API.";

  private client: LinearClient | null;

  constructor(runtime?: IAgentRuntime, client?: LinearClient) {
    super(runtime);
    this.client = client ?? null;
  }

  static override async start(runtime: IAgentRuntime): Promise<LinearService> {
    return new LinearService(runtime);
  }

  override async stop(): Promise<void> {
    this.client = null;
  }

  isConfigured(): boolean {
    return this.client !== null || this.resolveCredential() !== null;
  }

  async getViewer(): Promise<LinearViewer> {
    return this.configuredClient().getViewer();
  }

  async listTeams(request: TeamListRequest = {}): Promise<LinearTeamPage> {
    return this.configuredClient().listTeams(request);
  }

  async searchIssues(request: IssueSearchRequest): Promise<LinearIssuePage> {
    return this.configuredClient().searchIssues(request);
  }

  async getIssue(identifier: string): Promise<LinearIssue | null> {
    return this.configuredClient().getIssue(identifier);
  }

  private resolveCredential(): LinearCredential | null {
    const runtime = this.runtime;
    if (!runtime) return null;
    const oauthToken = setting(runtime, "LINEAR_OAUTH_TOKEN");
    if (oauthToken) return { type: "oauth", value: oauthToken };
    const apiKey = setting(runtime, "LINEAR_API_KEY");
    if (apiKey) return { type: "apiKey", value: apiKey };
    return null;
  }

  private configuredClient(): LinearClient {
    if (this.client) return this.client;
    const credential = this.resolveCredential();
    if (!credential) {
      throw new LinearError(
        "Linear is not connected. Configure LINEAR_API_KEY or connect a managed Linear account.",
        { code: "LINEAR_NOT_CONFIGURED" },
      );
    }
    this.client = new LinearClient({ credential });
    return this.client;
  }
}

function setting(runtime: IAgentRuntime, key: string): string | null {
  const value = runtime.getSetting(key);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function getLinearService(runtime: IAgentRuntime): LinearService {
  const service = runtime.getService<LinearService>(LINEAR_SERVICE_TYPE);
  if (!service) {
    throw new LinearError("LinearService is not registered.", {
      code: "LINEAR_UNAVAILABLE",
    });
  }
  return service;
}
