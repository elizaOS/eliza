/**
 * HTTP client for the Eliza Cloud Eliza Sandbox API.
 */
import { normalizeCloudSiteUrl } from "./base-url.js";

export type CloudChainType = "evm" | "solana";
export type CloudWalletProvider = "privy" | "steward";

export interface CloudWalletDescriptor {
  agentWalletId: string;
  walletAddress: string;
  walletProvider: CloudWalletProvider;
  chainType: CloudChainType;
  balance?: string | number;
}

interface CloudWalletAddresses {
  evm?: string | null;
  solana?: string | null;
}

export interface SignedRpcEnvelope {
  clientAddress: string;
  payload: {
    method: string;
    params: unknown[];
  };
  nonce: string;
  timestamp: number;
  signature: string;
  correlationId?: string;
}

export interface RpcResult {
  [key: string]: unknown;
}

export class CloudBridgeError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "CloudBridgeError";
  }
}

export class SignatureInvalidError extends CloudBridgeError {
  constructor(message: string, body?: string) {
    super(message, 401, body);
    this.name = "SignatureInvalidError";
  }
}

export class NonceReplayError extends CloudBridgeError {
  constructor(message: string, body?: string) {
    super(message, 409, body);
    this.name = "NonceReplayError";
  }
}

export class SessionExpiredError extends CloudBridgeError {
  constructor(message: string, body?: string) {
    super(message, 410, body);
    this.name = "SessionExpiredError";
  }
}

export class CloudUnavailableError extends CloudBridgeError {
  constructor(message: string, status: number, body?: string) {
    super(message, status, body);
    this.name = "CloudUnavailableError";
  }
}

export interface CloudAgent {
  id: string;
  agentName: string;
  status: string;
  databaseStatus: string;
  bridgeUrl?: string;
  lastBackupAt?: string;
  lastHeartbeatAt?: string;
  errorMessage?: string;
  errorCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CloudAgentCreateParams {
  agentName: string;
  agentConfig?: Record<string, unknown>;
  environmentVars?: Record<string, string>;
}

export interface ProvisionInfo {
  id: string;
  agentName: string;
  status: string;
  bridgeUrl?: string;
  healthUrl?: string;
}

export interface BackupInfo {
  id: string;
  snapshotType: string;
  sizeBytes: number | null;
  createdAt: string;
}

export type ChatChannelType =
  | "DM"
  | "GROUP"
  | "VOICE_DM"
  | "VOICE_GROUP"
  | "API";

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

function formatApiErrorBody(text: string): string | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as {
      error?: unknown;
      details?: Array<{ message?: unknown }>;
    };
    const baseError =
      typeof parsed.error === "string" && parsed.error.trim().length > 0
        ? parsed.error.trim()
        : null;
    const details = Array.isArray(parsed.details)
      ? parsed.details
          .map((detail) =>
            typeof detail?.message === "string" ? detail.message.trim() : "",
          )
          .filter((message) => message.length > 0)
      : [];
    if (baseError && details.length > 0) {
      return `${baseError}: ${details.join("; ")}`;
    }
    if (baseError) return baseError;
  } catch {
    /* plain text */
  }

  return text.slice(0, 200) || null;
}

function isRedirectResponse(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}

function normalizeChainAddress(
  addresses: CloudWalletAddresses | null | undefined,
  chain: CloudChainType,
): string | null {
  const value = addresses?.[chain];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function looksLikeChainAddress(
  address: string,
  chain: CloudChainType,
): boolean {
  if (chain === "evm") {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }

  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

function resolveRequestedWalletAddress(
  data: {
    walletAddress: string | null;
    walletAddresses?: CloudWalletAddresses | null;
  },
  chain: CloudChainType,
): string | null {
  const explicit = normalizeChainAddress(data.walletAddresses, chain);
  if (explicit) return explicit;
  if (typeof data.walletAddress !== "string") return null;

  const trimmed = data.walletAddress.trim();
  if (!trimmed) return null;
  return looksLikeChainAddress(trimmed, chain) ? trimmed : null;
}

export class ElizaCloudClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = normalizeCloudSiteUrl(baseUrl);
    this.apiKey = apiKey;
  }

  async listAgents(): Promise<CloudAgent[]> {
    const res = await this.request<CloudAgent[]>("GET", "/api/v1/eliza/agents");
    return res.data ?? [];
  }

  async createAgent(params: CloudAgentCreateParams): Promise<CloudAgent> {
    const res = await this.request<CloudAgent>(
      "POST",
      "/api/v1/eliza/agents",
      params,
    );
    if (!res.success || !res.data)
      throw new Error(res.error ?? "Failed to create cloud agent");
    return res.data;
  }

  async getAgent(agentId: string): Promise<CloudAgent> {
    const res = await this.request<CloudAgent>(
      "GET",
      `/api/v1/eliza/agents/${agentId}`,
    );
    if (!res.success || !res.data)
      throw new Error(res.error ?? "Agent not found");
    return res.data;
  }

  async deleteAgent(agentId: string): Promise<void> {
    const res = await this.request<void>(
      "DELETE",
      `/api/v1/eliza/agents/${agentId}`,
    );
    if (!res.success) throw new Error(res.error ?? "Failed to delete agent");
  }

  async provision(agentId: string): Promise<ProvisionInfo> {
    const res = await this.request<ProvisionInfo>(
      "POST",
      `/api/v1/eliza/agents/${agentId}/provision`,
    );
    if (!res.success || !res.data)
      throw new Error(res.error ?? "Failed to provision sandbox");
    return res.data;
  }

  async sendMessage(
    agentId: string,
    text: string,
    roomId = "web-chat",
    channelType: ChatChannelType = "DM",
  ): Promise<string> {
    const url = `${this.baseUrl}/api/v1/eliza/agents/${agentId}/bridge`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": this.apiKey },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "message.send",
        params: { text, roomId, channelType },
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });

    if (isRedirectResponse(response)) {
      throw new Error(
        "Bridge request was redirected; redirects are not allowed",
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `Bridge request failed: HTTP ${response.status} ${errorText.slice(0, 200)}`,
      );
    }

    const rpc = (await response.json()) as {
      result?: { text?: string };
      error?: { code: number; message: string };
    };

    if (rpc.error) throw new Error(rpc.error.message);
    return rpc.result?.text ?? "(no response)";
  }

  async *sendMessageStream(
    agentId: string,
    text: string,
    roomId = "web-chat",
    channelType: ChatChannelType = "DM",
  ): AsyncGenerator<{ type: string; data: Record<string, unknown> }> {
    const url = `${this.baseUrl}/api/v1/eliza/agents/${agentId}/stream`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": this.apiKey },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "message.send",
        params: { text, roomId, channelType },
      }),
      redirect: "manual",
    });

    if (isRedirectResponse(response)) {
      throw new Error(
        "Stream request was redirected; redirects are not allowed",
      );
    }

    if (!response.ok || !response.body) {
      throw new Error(`Stream request failed: HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        if (!part.trim()) continue;
        let eventType = "message";
        let eventData = "";

        for (const line of part.split("\n")) {
          if (line.startsWith("event: ")) eventType = line.slice(7).trim();
          else if (line.startsWith("data: "))
            eventData += (eventData ? "\n" : "") + line.slice(6);
        }

        if (eventData) {
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(eventData) as Record<string, unknown>;
          } catch {
            continue;
          }
          yield { type: eventType, data };
        }
      }
    }
  }

  async snapshot(agentId: string): Promise<BackupInfo> {
    const res = await this.request<BackupInfo>(
      "POST",
      `/api/v1/eliza/agents/${agentId}/snapshot`,
    );
    if (!res.success || !res.data)
      throw new Error(res.error ?? "Snapshot failed");
    return res.data;
  }

  async listBackups(agentId: string): Promise<BackupInfo[]> {
    const res = await this.request<BackupInfo[]>(
      "GET",
      `/api/v1/eliza/agents/${agentId}/backups`,
    );
    return res.data ?? [];
  }

  async restore(agentId: string, backupId?: string): Promise<void> {
    const res = await this.request<void>(
      "POST",
      `/api/v1/eliza/agents/${agentId}/restore`,
      backupId ? { backupId } : {},
    );
    if (!res.success) throw new Error(res.error ?? "Restore failed");
  }

  async heartbeat(agentId: string): Promise<boolean> {
    const url = `${this.baseUrl}/api/v1/eliza/agents/${agentId}/bridge`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": this.apiKey,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "heartbeat" }),
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      if (isRedirectResponse(response)) return false;
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Fetch the cloud-side wallet descriptor for an agent.
   * Uses the standard API-key auth (X-Api-Key).
   */
  async getAgentWallet(
    agentId: string,
    chain: CloudChainType,
  ): Promise<CloudWalletDescriptor> {
    const res = await this.request<{
      agentId?: string;
      walletAddress: string | null;
      walletAddresses?: CloudWalletAddresses | null;
      walletProvider: CloudWalletProvider | null;
      walletStatus?: string;
      balance?: string | number | null;
      chain?: string;
    }>(
      "GET",
      `/api/v1/eliza/agents/${encodeURIComponent(agentId)}/wallet?chain=${encodeURIComponent(chain)}`,
    );

    if (!res.success || !res.data) {
      throw new CloudBridgeError(res.error ?? "Failed to fetch agent wallet");
    }

    const data = res.data;
    const walletAddress = resolveRequestedWalletAddress(data, chain);
    if (!walletAddress || !data.walletProvider) {
      throw new CloudBridgeError(
        `Agent has no cloud ${chain} wallet provisioned`,
      );
    }

    return {
      agentWalletId: data.agentId ?? agentId,
      walletAddress,
      walletProvider: data.walletProvider,
      chainType: chain,
      balance: data.balance ?? undefined,
    };
  }

  /**
   * Provision a cloud-custodied server wallet tied to a local client address.
   * Idempotent server-side: returns the existing wallet if one already exists
   * for the (user, clientAddress, chain) tuple.
   */
  async provisionWallet(input: {
    chainType: CloudChainType;
    clientAddress: string;
  }): Promise<{
    walletId: string;
    address: string;
    chainType: CloudChainType;
    provider: CloudWalletProvider;
  }> {
    const res = await this.request<{
      id: string;
      address: string;
      chainType: CloudChainType;
      clientAddress: string;
      provider?: CloudWalletProvider;
    }>("POST", "/api/v1/user/wallets/provision", input);

    if (!res.success || !res.data) {
      throw new CloudBridgeError(res.error ?? "Failed to provision wallet");
    }

    return {
      walletId: res.data.id,
      address: res.data.address,
      chainType: res.data.chainType,
      provider: res.data.provider ?? "privy",
    };
  }

  /**
   * Execute a signed RPC envelope through the cloud custodial signer.
   *
   * Auth: body-embedded wallet signature — we MUST NOT send X-Api-Key/Bearer
   * headers here. The cloud verifies the signature against the
   * agentServerWallets.client_address registered at provision time.
   *
   * Error mapping:
   *   401 → SignatureInvalidError
   *   409 → NonceReplayError
   *   410 → SessionExpiredError
   *   5xx → CloudUnavailableError
   */
  async executeRpc(envelope: SignedRpcEnvelope): Promise<RpcResult> {
    const { correlationId, ...body } = envelope;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (correlationId) {
      headers["X-Correlation-Id"] = correlationId;
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/v1/user/wallets/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new CloudUnavailableError(
        `Cloud RPC network error: ${(err as Error).message}`,
        0,
      );
    }

    if (isRedirectResponse(response)) {
      throw new CloudBridgeError(
        "Cloud RPC request was redirected; redirects are not allowed",
        response.status,
      );
    }

    const text = await response.text().catch(() => "");

    if (response.ok) {
      try {
        const parsed = JSON.parse(text) as ApiResponse<RpcResult>;
        if (!parsed.success || parsed.data === undefined) {
          throw new CloudBridgeError(
            parsed.error ?? "Cloud RPC returned no data",
            response.status,
            text,
          );
        }
        return parsed.data;
      } catch (err) {
        if (err instanceof CloudBridgeError) throw err;
        throw new CloudBridgeError(
          `Cloud RPC returned malformed JSON: ${(err as Error).message}`,
          response.status,
          text,
        );
      }
    }

    let errMessage = `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) errMessage = parsed.error;
    } catch {
      if (text) errMessage = text.slice(0, 200);
    }

    if (response.status === 401) {
      throw new SignatureInvalidError(errMessage, text);
    }
    if (response.status === 409) {
      throw new NonceReplayError(errMessage, text);
    }
    if (response.status === 410) {
      throw new SessionExpiredError(errMessage, text);
    }
    if (response.status >= 500) {
      throw new CloudUnavailableError(errMessage, response.status, text);
    }
    throw new CloudBridgeError(errMessage, response.status, text);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { "X-Api-Key": this.apiKey };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });

    if (isRedirectResponse(response)) {
      return {
        success: false,
        error: "Cloud API request was redirected; redirects are not allowed",
      };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        success: false,
        error: formatApiErrorBody(text) ?? `HTTP ${response.status}`,
      };
    }

    return (await response.json()) as ApiResponse<T>;
  }
}
