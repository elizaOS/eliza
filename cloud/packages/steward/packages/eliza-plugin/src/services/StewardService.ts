import { type IAgentRuntime, Service } from "@elizaos/core";
import {
  type AgentDashboardResponse,
  type AgentIdentity,
  type ApprovalQueueEntry,
  type ApprovalStats,
  type GetBalanceResult,
  type GetHistoryResult,
  type PolicyRule,
  type SignMessageResult,
  type SignTransactionInput,
  type SignTransactionResult,
  StewardApiError,
  StewardClient,
} from "@stwd/sdk";
import type { StewardPluginConfig } from "../types.js";

/**
 * Singleton service wrapping StewardClient for the ElizaOS runtime.
 *
 * Handles initialization, health checks, auto-discovery, and auto-registration.
 * Access via `runtime.getService("STEWARD")`.
 */
export class StewardService extends Service {
  static serviceType = "steward" as const;
  capabilityDescription =
    "Steward managed wallet — policy-enforced signing, balances, and approval flows";

  private client: StewardClient | null = null;
  private pluginConfig: StewardPluginConfig | null = null;
  private agentIdentity: AgentIdentity | null = null;
  private _connected = false;

  static async start(runtime: IAgentRuntime): Promise<StewardService> {
    const service = new StewardService(runtime);
    await service.initialize(runtime);
    return service;
  }

  async stop(): Promise<void> {
    this.client = null;
    this._connected = false;
    this.agentIdentity = null;
  }

  // ── Initialization ──────────────────────────────────────────────

  private async initialize(runtime: IAgentRuntime): Promise<void> {
    this.pluginConfig = this.resolveConfig(runtime);

    if (!this.pluginConfig) {
      console.warn("[Steward] No configuration found, plugin disabled");
      return;
    }

    this.client = new StewardClient({
      baseUrl: this.pluginConfig.apiUrl,
      apiKey: this.pluginConfig.apiKey,
      tenantId: this.pluginConfig.tenantId,
    });

    // Probe health + fetch agent identity
    try {
      this.agentIdentity = await this.client.getAgent(this.pluginConfig.agentId);
      this._connected = true;
      console.info(`[Steward] Connected. Wallet: ${this.agentIdentity.walletAddress}`);
    } catch (err) {
      if (err instanceof StewardApiError && err.status === 404 && this.pluginConfig.autoRegister) {
        await this.tryAutoRegister(runtime);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Steward] Could not connect: ${msg}`);
        if (this.pluginConfig.fallbackLocal) {
          console.info("[Steward] Falling back to local signing");
        }
      }
    }
  }

  private async tryAutoRegister(runtime: IAgentRuntime): Promise<void> {
    try {
      const name = this.getRuntimeState(runtime).character?.name ?? this.getAgentId();
      this.agentIdentity = await this.getClient().createWallet(this.getAgentId(), name);
      this._connected = true;
      console.info(`[Steward] Registered new wallet: ${this.agentIdentity.walletAddress}`);
    } catch (regErr) {
      const msg = regErr instanceof Error ? regErr.message : String(regErr);
      console.error(`[Steward] Failed to auto-register agent: ${msg}`);
    }
  }

  // ── Config Resolution ───────────────────────────────────────────

  private resolveConfig(runtime: IAgentRuntime): StewardPluginConfig | null {
    const runtimeState = this.getRuntimeState(runtime);
    const settings = runtimeState.character?.settings?.steward ?? {};
    const env = process.env;

    const apiUrl = settings.apiUrl ?? env.STEWARD_API_URL ?? "http://localhost:7860";

    return {
      apiUrl,
      apiKey: settings.apiKey ?? env.STEWARD_API_KEY,
      agentId: settings.agentId ?? env.STEWARD_AGENT_ID ?? runtimeState.agentId ?? "default",
      tenantId: settings.tenantId ?? env.STEWARD_TENANT_ID,
      autoRegister: settings.autoRegister ?? env.STEWARD_AUTO_REGISTER !== "false",
      fallbackLocal: settings.fallbackLocal ?? env.STEWARD_FALLBACK_LOCAL !== "false",
    };
  }

  // ── Public API ──────────────────────────────────────────────────

  isConnected(): boolean {
    return this._connected && this.client !== null;
  }

  getConfig(): StewardPluginConfig | null {
    return this.pluginConfig;
  }

  async signTransaction(tx: SignTransactionInput): Promise<SignTransactionResult> {
    this.assertConnected();
    return this.getClient().signTransaction(this.getAgentId(), tx);
  }

  async signMessage(message: string): Promise<SignMessageResult> {
    this.assertConnected();
    return this.getClient().signMessage(this.getAgentId(), message);
  }

  async getBalance(chainId?: number): Promise<GetBalanceResult> {
    this.assertConnected();
    return this.getClient().getBalance(this.getAgentId(), chainId);
  }

  async getAgent(): Promise<AgentIdentity> {
    this.assertConnected();
    if (!this.agentIdentity) {
      throw new Error("Steward agent identity not loaded");
    }
    return this.agentIdentity;
  }

  async getPolicies(): Promise<PolicyRule[]> {
    this.assertConnected();
    return this.getClient().getPolicies(this.getAgentId());
  }

  async getHistory(): Promise<GetHistoryResult> {
    this.assertConnected();
    return this.getClient().getHistory(this.getAgentId());
  }

  async getDashboard(): Promise<AgentDashboardResponse> {
    this.assertConnected();
    return this.getClient().getAgentDashboard(this.getAgentId());
  }

  async listApprovals(opts?: {
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<ApprovalQueueEntry[]> {
    this.assertConnected();
    return this.getClient().listApprovals(opts);
  }

  async getApprovalStats(): Promise<ApprovalStats> {
    this.assertConnected();
    return this.getClient().getApprovalStats();
  }

  // ── Internal ────────────────────────────────────────────────────

  private getRuntimeState(runtime: IAgentRuntime): IAgentRuntime & {
    agentId?: string;
    character?: {
      name?: string;
      settings?: {
        steward?: Partial<StewardPluginConfig>;
      };
    };
  } {
    return runtime as IAgentRuntime & {
      agentId?: string;
      character?: {
        name?: string;
        settings?: {
          steward?: Partial<StewardPluginConfig>;
        };
      };
    };
  }

  private getClient(): StewardClient {
    if (!this.client) {
      throw new Error("Steward service not connected");
    }
    return this.client;
  }

  private getAgentId(): string {
    const agentId = this.pluginConfig?.agentId;
    if (!agentId) {
      throw new Error("Steward agent id is not configured");
    }
    return agentId;
  }

  private assertConnected(): void {
    if (!this._connected || !this.client) {
      throw new Error("Steward service not connected");
    }
  }
}
