// Temporary dashboard client kept in sync with @stwd/sdk.

// ---- Secrets ----
export interface SecretRecord {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  version: number;
  routeCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SecretCreatePayload {
  name: string;
  value: string;
  description?: string;
}

export interface SecretRotatePayload {
  value: string;
}

// ---- Routes ----
export interface RouteRecord {
  id: string;
  secretId: string;
  hostPattern: string;
  pathPattern?: string;
  injectAs: "header" | "query" | "body";
  headerName?: string;
  queryParam?: string;
  bodyPath?: string;
  createdAt: string;
}

export interface RouteCreatePayload {
  secretId: string;
  hostPattern: string;
  pathPattern?: string;
  injectAs: "header" | "query" | "body";
  headerName?: string;
  queryParam?: string;
  bodyPath?: string;
}

// ---- Policies ----
export interface PolicyRecord {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  type: "api_access" | "spend_limit" | "rate_limit" | "transaction";
  rules: Record<string, unknown>;
  assignedAgents: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PolicyCreatePayload {
  name: string;
  description?: string;
  type: PolicyRecord["type"];
  rules: Record<string, unknown>;
}

export interface PolicySimulatePayload {
  policyId: string;
  agentId: string;
  request: {
    method?: string;
    url?: string;
    value?: string;
    data?: string;
  };
}

export interface PolicySimulateResult {
  allowed: boolean;
  reason?: string;
  matchedRules: string[];
}

// ---- Audit ----
export interface AuditEntry {
  id: string;
  tenantId: string;
  agentId?: string;
  agentName?: string;
  action: string;
  result: "allow" | "deny" | "error";
  details?: Record<string, unknown>;
  cost?: string;
  timestamp: string;
}

export interface AuditQueryParams {
  agentId?: string;
  action?: string;
  result?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface AuditSummary {
  agentId: string;
  agentName?: string;
  totalActions: number;
  totalCost: string;
  allowCount: number;
  denyCount: number;
}

export interface StewardClientConfig {
  baseUrl: string;
  apiKey?: string;
  tenantId?: string;
  authToken?: string; // JWT from passkey/email auth
}

export interface AgentIdentity {
  id: string;
  tenantId: string;
  name: string;
  walletAddress: string;
  erc8004TokenId?: string;
  platformId?: string;
  createdAt: Date;
}

export interface PolicyRule {
  id: string;
  type: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface PolicyResult {
  policyId: string;
  type: string;
  passed: boolean;
  reason?: string;
}

export interface TxRecord {
  id: string;
  agentId: string;
  status: string;
  toAddress: string;
  value: string;
  data?: string;
  chainId: number;
  txHash?: string;
  policyResults: PolicyResult[];
  createdAt: string;
  signedAt?: string;
  confirmedAt?: string;
  request?: {
    to: string;
    value: string;
    data?: string;
    chainId: number;
  };
}

interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export class StewardClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(config: StewardClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.headers = {
      "Content-Type": "application/json",
      // JWT Bearer takes priority over tenant header auth
      ...(config.authToken
        ? { Authorization: `Bearer ${config.authToken}` }
        : {
            ...(config.tenantId ? { "X-Steward-Tenant": config.tenantId } : {}),
            ...(config.apiKey ? { "X-Steward-Key": config.apiKey } : {}),
          }),
    };
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: { ...this.headers, ...options?.headers },
    });
    const json: ApiResponse<T> = await res.json();
    if (!json.ok) throw new Error(json.error || `Request failed: ${res.status}`);
    return json.data as T;
  }

  async createWallet(id: string, name: string, platformId?: string): Promise<AgentIdentity> {
    return this.request<AgentIdentity>("/agents", {
      method: "POST",
      body: JSON.stringify({ id, name, platformId }),
    });
  }

  async getAgent(agentId: string): Promise<AgentIdentity> {
    return this.request<AgentIdentity>(`/agents/${agentId}`);
  }

  async listAgents(): Promise<AgentIdentity[]> {
    return this.request<AgentIdentity[]>("/agents");
  }

  async getBalance(agentId: string, chainId?: number) {
    const qs = chainId ? `?chainId=${chainId}` : "";
    return this.request<{
      agentId: string;
      walletAddress: string;
      balances: {
        native: string;
        nativeFormatted: string;
        chainId: number;
        symbol: string;
      };
    }>(`/agents/${agentId}/balance${qs}`);
  }

  async getPolicies(agentId: string): Promise<PolicyRule[]> {
    return this.request<PolicyRule[]>(`/agents/${agentId}/policies`);
  }

  async setPolicies(agentId: string, policies: PolicyRule[]): Promise<PolicyRule[]> {
    return this.request<PolicyRule[]>(`/agents/${agentId}/policies`, {
      method: "PUT",
      body: JSON.stringify(policies),
    });
  }

  async signTransaction(
    agentId: string,
    tx: { to: string; value: string; data?: string; chainId?: number },
  ) {
    return this.request(`/vault/${agentId}/sign`, {
      method: "POST",
      body: JSON.stringify(tx),
    });
  }

  async getHistory(agentId: string): Promise<TxRecord[]> {
    return this.request<TxRecord[]>(`/vault/${agentId}/history`);
  }

  async listApprovals(status: "pending" | "approved" | "rejected" | "all" = "pending") {
    // Request the max page size (200) so the dashboard shows all pending items
    // in a single load. The old /vault/:agentId/pending endpoint was unlimited.
    const params = new URLSearchParams({ limit: "200" });
    if (status !== "pending") params.set("status", status);
    const qs = `?${params.toString()}`;
    return this.request<
      {
        id: string;
        txId: string;
        agentId: string;
        agentName?: string;
        status: "pending" | "approved" | "rejected";
        requestedAt: string;
        resolvedAt?: string;
        resolvedBy?: string;
        toAddress?: string;
        value?: string;
        chainId?: number;
        txStatus?: string;
        comment?: string;
        reason?: string;
      }[]
    >(`/approvals${qs}`);
  }

  async approveTransaction(txId: string, comment?: string) {
    return this.request(`/approvals/${txId}/approve`, {
      method: "POST",
      body: JSON.stringify(comment ? { comment } : {}),
    });
  }

  async denyTransaction(txId: string, reason: string) {
    return this.request(`/approvals/${txId}/deny`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
  }

  // ---- Secrets ----
  async listSecrets(): Promise<SecretRecord[]> {
    return this.request<SecretRecord[]>("/secrets");
  }

  async createSecret(payload: SecretCreatePayload): Promise<SecretRecord> {
    return this.request<SecretRecord>("/secrets", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async getSecret(secretId: string): Promise<SecretRecord> {
    return this.request<SecretRecord>(`/secrets/${secretId}`);
  }

  async rotateSecret(secretId: string, payload: SecretRotatePayload): Promise<SecretRecord> {
    return this.request<SecretRecord>(`/secrets/${secretId}/rotate`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async deleteSecret(secretId: string): Promise<void> {
    return this.request<void>(`/secrets/${secretId}`, { method: "DELETE" });
  }

  // ---- Routes ----
  async listRoutes(secretId?: string): Promise<RouteRecord[]> {
    const qs = secretId ? `?secretId=${encodeURIComponent(secretId)}` : "";
    return this.request<RouteRecord[]>(`/secrets/routes${qs}`);
  }

  async createRoute(payload: RouteCreatePayload): Promise<RouteRecord> {
    return this.request<RouteRecord>("/secrets/routes", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async updateRoute(routeId: string, payload: Partial<RouteCreatePayload>): Promise<RouteRecord> {
    return this.request<RouteRecord>(`/secrets/routes/${routeId}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  }

  async deleteRoute(routeId: string): Promise<void> {
    return this.request<void>(`/secrets/routes/${routeId}`, {
      method: "DELETE",
    });
  }

  // ---- Policies ----
  async listPolicies(): Promise<PolicyRecord[]> {
    return this.request<PolicyRecord[]>("/policies");
  }

  async createPolicy(payload: PolicyCreatePayload): Promise<PolicyRecord> {
    return this.request<PolicyRecord>("/policies", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async getPolicy(policyId: string): Promise<PolicyRecord> {
    return this.request<PolicyRecord>(`/policies/${policyId}`);
  }

  async updatePolicy(
    policyId: string,
    payload: Partial<PolicyCreatePayload>,
  ): Promise<PolicyRecord> {
    return this.request<PolicyRecord>(`/policies/${policyId}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  }

  async deletePolicy(policyId: string): Promise<void> {
    return this.request<void>(`/policies/${policyId}`, { method: "DELETE" });
  }

  async assignPolicy(policyId: string, agentIds: string[]): Promise<PolicyRecord> {
    return this.request<PolicyRecord>(`/policies/${policyId}/assign`, {
      method: "POST",
      body: JSON.stringify({ agentIds }),
    });
  }

  async simulatePolicy(payload: PolicySimulatePayload): Promise<PolicySimulateResult> {
    return this.request<PolicySimulateResult>("/policies/simulate", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  // ---- Audit ----
  async getAuditLog(params?: AuditQueryParams): Promise<AuditEntry[]> {
    const mapped: Record<string, string> = {};
    if (params?.agentId) mapped.agentId = params.agentId;
    if (params?.action) mapped.action = params.action;
    if (params?.result) mapped.status = params.result;
    if (params?.from) mapped.dateFrom = params.from;
    if (params?.to) mapped.dateTo = params.to;
    if (params?.limit) mapped.limit = String(params.limit);
    if (params?.offset !== undefined && params.limit) {
      mapped.page = String(Math.floor(params.offset / params.limit) + 1);
    }
    const qs = Object.keys(mapped).length ? `?${new URLSearchParams(mapped).toString()}` : "";
    const result = await this.request<{
      data: Array<{
        id: string;
        timestamp: string;
        agentId: string;
        action: string;
        status: string;
        details?: Record<string, unknown>;
        policyResults?: unknown;
        value?: string;
        to?: string;
      }>;
      pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
      };
    }>(`/audit/log${qs}`);
    // Map API response to AuditEntry shape expected by dashboard
    return result.data.map((e) => ({
      id: e.id,
      tenantId: "",
      agentId: e.agentId,
      action: e.action,
      result:
        e.status === "rejected" || e.status === "error" || e.status === "denied"
          ? "deny"
          : e.status === "error"
            ? "error"
            : ("allow" as AuditEntry["result"]),
      details: e.details,
      cost: e.value,
      timestamp: e.timestamp,
    }));
  }

  async getAuditSummary(range?: "24h" | "7d" | "30d" | "all"): Promise<AuditSummary[]> {
    const qs = range ? `?range=${range}` : "";
    const result = await this.request<{
      totalTransactions: number;
      totalApprovals: number;
      totalRejections: number;
      totalProxyRequests: number;
      policyViolations: number;
      topAgents: Array<{ agentId: string; name: string; txCount: number }>;
      dailyActivity: Array<{ date: string; txCount: number }>;
    }>(`/audit/summary${qs}`);
    // Map to per-agent AuditSummary[] expected by dashboard
    return result.topAgents.map((a) => ({
      agentId: a.agentId,
      agentName: a.name,
      totalActions: a.txCount,
      totalCost: "0",
      allowCount: a.txCount,
      denyCount: 0,
    }));
  }

  async getAuditSummaryFull(range?: "24h" | "7d" | "30d" | "all"): Promise<{
    totalTransactions: number;
    totalApprovals: number;
    totalRejections: number;
    totalProxyRequests: number;
    policyViolations: number;
    topAgents: Array<{ agentId: string; name: string; txCount: number }>;
    dailyActivity: Array<{ date: string; txCount: number }>;
  }> {
    const qs = range ? `?range=${range}` : "";
    return this.request(`/audit/summary${qs}`);
  }

  async exportAuditCsv(params?: AuditQueryParams): Promise<string> {
    const mapped: Record<string, string> = {};
    if (params?.agentId) mapped.agentId = params.agentId;
    if (params?.action) mapped.action = params.action;
    if (params?.result) mapped.status = params.result;
    if (params?.from) mapped.dateFrom = params.from;
    if (params?.to) mapped.dateTo = params.to;
    const qs = Object.keys(mapped).length ? `?${new URLSearchParams(mapped).toString()}` : "";
    const res = await fetch(`${this.baseUrl}/audit/export${qs}`, {
      headers: this.headers,
    });
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    return res.text();
  }

  // ---- Tenants ----
  async listTenants(): Promise<
    Array<{
      tenantId: string;
      tenantName: string;
      role: string;
      joinedAt: string;
    }>
  > {
    return this.request<
      Array<{
        tenantId: string;
        tenantName: string;
        role: string;
        joinedAt: string;
      }>
    >("/user/me/tenants");
  }

  async createTenant(
    name: string,
    description?: string,
  ): Promise<{ tenantId: string; apiKey: string }> {
    return this.request<{ tenantId: string; apiKey: string }>("/user/me/tenants", {
      method: "POST",
      body: JSON.stringify({ name, description }),
    });
  }

  async switchTenant(tenantId: string): Promise<void> {
    return this.request<void>("/user/me/tenants/switch", {
      method: "POST",
      body: JSON.stringify({ tenantId }),
    });
  }
}
