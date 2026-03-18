/**
 * HTTP client for the Eliza Cloud Milady Sandbox API.
 */

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

function isRedirectResponse(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}

export class ElizaCloudClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  async listAgents(): Promise<CloudAgent[]> {
    const res = await this.request<CloudAgent[]>(
      "GET",
      "/api/v1/milady/agents",
    );
    return res.data ?? [];
  }

  async createAgent(params: CloudAgentCreateParams): Promise<CloudAgent> {
    const res = await this.request<CloudAgent>(
      "POST",
      "/api/v1/milady/agents",
      params,
    );
    if (!res.success || !res.data)
      throw new Error(res.error ?? "Failed to create cloud agent");
    return res.data;
  }

  async getAgent(agentId: string): Promise<CloudAgent> {
    const res = await this.request<CloudAgent>(
      "GET",
      `/api/v1/milady/agents/${agentId}`,
    );
    if (!res.success || !res.data)
      throw new Error(res.error ?? "Agent not found");
    return res.data;
  }

  async deleteAgent(agentId: string): Promise<void> {
    const res = await this.request<void>(
      "DELETE",
      `/api/v1/milady/agents/${agentId}`,
    );
    if (!res.success) throw new Error(res.error ?? "Failed to delete agent");
  }

  async provision(agentId: string): Promise<ProvisionInfo> {
    const res = await this.request<ProvisionInfo>(
      "POST",
      `/api/v1/milady/agents/${agentId}/provision`,
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
    const url = `${this.baseUrl}/api/v1/milady/agents/${agentId}/bridge`;
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
    const url = `${this.baseUrl}/api/v1/milady/agents/${agentId}/stream`;
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
          else if (line.startsWith("data: ")) eventData = line.slice(6);
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
      `/api/v1/milady/agents/${agentId}/snapshot`,
    );
    if (!res.success || !res.data)
      throw new Error(res.error ?? "Snapshot failed");
    return res.data;
  }

  async listBackups(agentId: string): Promise<BackupInfo[]> {
    const res = await this.request<BackupInfo[]>(
      "GET",
      `/api/v1/milady/agents/${agentId}/backups`,
    );
    return res.data ?? [];
  }

  async restore(agentId: string, backupId?: string): Promise<void> {
    const res = await this.request<void>(
      "POST",
      `/api/v1/milady/agents/${agentId}/restore`,
      backupId ? { backupId } : {},
    );
    if (!res.success) throw new Error(res.error ?? "Restore failed");
  }

  async heartbeat(agentId: string): Promise<boolean> {
    const url = `${this.baseUrl}/api/v1/milady/agents/${agentId}/bridge`;
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
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text);
      } catch {
        /* plain text */
      }
      return {
        success: false,
        error:
          (parsed.error as string) ??
          `HTTP ${response.status}: ${text.slice(0, 200)}`,
      };
    }

    return (await response.json()) as ApiResponse<T>;
  }
}
