import { CloudApiClient, ElizaCloudHttpClient } from "./http.js";
import { ElizaCloudPublicRoutesClient } from "./public-routes.js";
import {
  type AgentLifecycleResponse,
  type AgentListResponse,
  type AgentResponse,
  type ApiKeyCreateRequest,
  type ApiKeyCreateResponse,
  type ApiKeyListResponse,
  type AuthPairResponse,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type CliLoginPollResponse,
  type CliLoginStartOptions,
  type CliLoginStartResponse,
  type CloudRequestOptions,
  type ContainerCredentialsResponse,
  type ContainerGetResponse,
  type ContainerHealthResponse,
  type ContainerListResponse,
  type ContainerQuotaResponse,
  type CreateAgentRequest,
  type CreateAgentResponse,
  type CreateContainerRequest,
  type CreateContainerResponse,
  type CreditBalanceResponse,
  type CreditSummaryResponse,
  DEFAULT_ELIZA_CLOUD_API_BASE_URL,
  DEFAULT_ELIZA_CLOUD_BASE_URL,
  type ElizaCloudClientOptions,
  type EmbeddingsRequest,
  type EmbeddingsResponse,
  type EndpointCallOptions,
  type GatewayRelayResponse,
  type GenerateImageRequest,
  type GenerateImageResponse,
  type HttpMethod,
  type JobStatus,
  type ModelListResponse,
  type OpenApiSpec,
  type PairingTokenResponse,
  type PollGatewayRelayResponse,
  type RegisterGatewayRelaySessionResponse,
  type ResponsesCreateRequest,
  type ResponsesCreateResponse,
  type SnapshotListResponse,
  type SnapshotType,
  type UpdateContainerRequest,
  type UserProfileResponse,
} from "./types.js";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeBaseUrl(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimTrailingSlash(trimmed && trimmed.length > 0 ? trimmed : fallback);
}

function encodePathParam(value: string | number): string {
  return encodeURIComponent(String(value));
}

function withPathParams(path: string, params?: Record<string, string | number>): string {
  if (!params) return path;
  return path.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    const value = params[key];
    if (value === undefined) {
      throw new Error(`Missing path parameter: ${key}`);
    }
    return encodePathParam(value);
  });
}

function getCryptoRandomUuid(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export class ElizaCloudClient {
  readonly http: ElizaCloudHttpClient;
  readonly v1: CloudApiClient;
  readonly routes: ElizaCloudPublicRoutesClient;
  readonly baseUrl: string;
  readonly apiBaseUrl: string;

  constructor(options: ElizaCloudClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl, DEFAULT_ELIZA_CLOUD_BASE_URL);
    this.apiBaseUrl = normalizeBaseUrl(options.apiBaseUrl, DEFAULT_ELIZA_CLOUD_API_BASE_URL);
    this.http = new ElizaCloudHttpClient({
      ...options,
      baseUrl: this.baseUrl,
    });
    this.v1 = new CloudApiClient(this.apiBaseUrl, options.apiKey, {
      bearerToken: options.bearerToken,
      defaultHeaders: options.defaultHeaders,
      fetchImpl: options.fetchImpl,
    });
    this.routes = new ElizaCloudPublicRoutesClient(this);
  }

  setApiKey(apiKey: string | undefined): void {
    this.http.setApiKey(apiKey);
    this.v1.setApiKey(apiKey);
  }

  setBearerToken(token: string | undefined): void {
    this.http.setBearerToken(token);
    this.v1.setBearerToken(token);
  }

  request<TResponse>(
    method: HttpMethod,
    path: string,
    options?: CloudRequestOptions,
  ): Promise<TResponse> {
    return this.http.request<TResponse>(method, path, options);
  }

  requestRaw(method: HttpMethod, path: string, options?: CloudRequestOptions): Promise<Response> {
    return this.http.requestRaw(method, path, options);
  }

  callEndpoint<TResponse>(
    method: HttpMethod,
    pathTemplate: string,
    options: EndpointCallOptions = {},
  ): Promise<TResponse> {
    const { pathParams, ...requestOptions } = options;
    return this.request<TResponse>(
      method,
      withPathParams(pathTemplate, pathParams),
      requestOptions,
    );
  }

  getOpenApiSpec(options: CloudRequestOptions = {}): Promise<OpenApiSpec> {
    return this.request<OpenApiSpec>("GET", "/api/openapi.json", options);
  }

  startCliLogin(options: CliLoginStartOptions = {}): Promise<CliLoginStartResponse> {
    const sessionId = options.sessionId ?? getCryptoRandomUuid();
    const query = options.returnTo ? `?returnTo=${encodeURIComponent(options.returnTo)}` : "";
    const browserUrl = `${this.baseUrl}/auth/cli-login?session=${encodeURIComponent(
      sessionId,
    )}${query}`;

    return this.request<{ status?: string; expiresAt?: string }>("POST", "/api/auth/cli-session", {
      json: { sessionId },
      skipAuth: true,
    }).then((response) => ({
      sessionId,
      browserUrl,
      status: response.status,
      expiresAt: response.expiresAt,
    }));
  }

  pollCliLogin(sessionId: string): Promise<CliLoginPollResponse> {
    return this.request<CliLoginPollResponse>(
      "GET",
      `/api/auth/cli-session/${encodePathParam(sessionId)}`,
      { skipAuth: true },
    );
  }

  pairWithToken(token: string, origin: string): Promise<AuthPairResponse> {
    return this.request<AuthPairResponse>("POST", "/api/auth/pair", {
      json: { token },
      headers: { Origin: origin },
      skipAuth: true,
    });
  }

  listModels(): Promise<ModelListResponse> {
    return this.v1.get<ModelListResponse>("/models", { skipAuth: true });
  }

  createResponse(request: ResponsesCreateRequest): Promise<ResponsesCreateResponse> {
    return this.v1.post<ResponsesCreateResponse>("/responses", request);
  }

  createChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    return this.v1.post<ChatCompletionResponse>("/chat/completions", request);
  }

  createEmbeddings(request: EmbeddingsRequest): Promise<EmbeddingsResponse> {
    return this.v1.post<EmbeddingsResponse>("/embeddings", request);
  }

  generateImage(request: GenerateImageRequest): Promise<GenerateImageResponse> {
    return this.v1.post<GenerateImageResponse>("/generate-image", request);
  }

  getCreditsBalance(options: { fresh?: boolean } = {}): Promise<CreditBalanceResponse> {
    return this.request<CreditBalanceResponse>("GET", "/api/v1/credits/balance", {
      query: options.fresh === undefined ? undefined : { fresh: options.fresh },
    });
  }

  getCreditsSummary(): Promise<CreditSummaryResponse> {
    return this.request<CreditSummaryResponse>("GET", "/api/v1/credits/summary");
  }

  listContainers(): Promise<ContainerListResponse> {
    return this.request<ContainerListResponse>("GET", "/api/v1/containers");
  }

  createContainer(request: CreateContainerRequest): Promise<CreateContainerResponse> {
    return this.request<CreateContainerResponse>("POST", "/api/v1/containers", {
      json: request,
    });
  }

  getContainer(containerId: string): Promise<ContainerGetResponse> {
    return this.request<ContainerGetResponse>(
      "GET",
      `/api/v1/containers/${encodePathParam(containerId)}`,
    );
  }

  updateContainer(
    containerId: string,
    request: UpdateContainerRequest,
  ): Promise<ContainerGetResponse> {
    return this.request<ContainerGetResponse>(
      "PATCH",
      `/api/v1/containers/${encodePathParam(containerId)}`,
      { json: request },
    );
  }

  deleteContainer(containerId: string): Promise<{ success: boolean; message?: string }> {
    return this.request("DELETE", `/api/v1/containers/${encodePathParam(containerId)}`);
  }

  getContainerHealth(containerId: string): Promise<ContainerHealthResponse> {
    return this.request<ContainerHealthResponse>(
      "GET",
      `/api/v1/containers/${encodePathParam(containerId)}/health`,
    );
  }

  getContainerMetrics(containerId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/api/v1/containers/${encodePathParam(containerId)}/metrics`);
  }

  getContainerLogs(containerId: string, tail?: number): Promise<string> {
    return this.requestRaw("GET", `/api/v1/containers/${encodePathParam(containerId)}/logs`, {
      query: tail === undefined ? undefined : { tail },
      headers: { Accept: "text/plain" },
    }).then(async (response) => {
      if (!response.ok) {
        await this.http.request("GET", `/api/v1/containers/${encodePathParam(containerId)}/logs`, {
          query: tail === undefined ? undefined : { tail },
        });
      }
      return response.text();
    });
  }

  getContainerDeployments(containerId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/api/v1/containers/${encodePathParam(containerId)}/deployments`);
  }

  getContainerQuota(): Promise<ContainerQuotaResponse> {
    return this.request<ContainerQuotaResponse>("GET", "/api/v1/containers/quota");
  }

  createContainerCredentials(
    request: Record<string, unknown> = {},
  ): Promise<ContainerCredentialsResponse> {
    return this.request<ContainerCredentialsResponse>("POST", "/api/v1/containers/credentials", {
      json: request,
    });
  }

  listAgents(): Promise<AgentListResponse> {
    return this.request<AgentListResponse>("GET", "/api/v1/eliza/agents");
  }

  createAgent(request: CreateAgentRequest): Promise<CreateAgentResponse> {
    return this.request<CreateAgentResponse>("POST", "/api/v1/eliza/agents", {
      json: request,
    });
  }

  getAgent(agentId: string): Promise<AgentResponse> {
    return this.request<AgentResponse>("GET", `/api/v1/eliza/agents/${encodePathParam(agentId)}`);
  }

  updateAgent(agentId: string, request: Partial<CreateAgentRequest>): Promise<AgentResponse> {
    return this.request<AgentResponse>(
      "PATCH",
      `/api/v1/eliza/agents/${encodePathParam(agentId)}`,
      { json: request },
    );
  }

  deleteAgent(agentId: string): Promise<AgentLifecycleResponse> {
    return this.request("DELETE", `/api/v1/eliza/agents/${encodePathParam(agentId)}`);
  }

  provisionAgent(agentId: string): Promise<AgentLifecycleResponse> {
    return this.request("POST", `/api/v1/eliza/agents/${encodePathParam(agentId)}/provision`);
  }

  suspendAgent(agentId: string): Promise<AgentLifecycleResponse> {
    return this.request("POST", `/api/v1/eliza/agents/${encodePathParam(agentId)}/suspend`);
  }

  resumeAgent(agentId: string): Promise<AgentLifecycleResponse> {
    return this.request("POST", `/api/v1/eliza/agents/${encodePathParam(agentId)}/resume`);
  }

  createAgentSnapshot(
    agentId: string,
    snapshotType: SnapshotType = "manual",
    metadata?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/v1/eliza/agents/${encodePathParam(agentId)}/snapshot`, {
      json: { snapshotType, metadata },
    });
  }

  listAgentBackups(agentId: string): Promise<SnapshotListResponse> {
    return this.request("GET", `/api/v1/eliza/agents/${encodePathParam(agentId)}/backups`);
  }

  restoreAgentBackup(agentId: string, backupId?: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/v1/eliza/agents/${encodePathParam(agentId)}/restore`, {
      json: backupId ? { backupId } : {},
    });
  }

  getAgentPairingToken(agentId: string): Promise<PairingTokenResponse> {
    return this.request<PairingTokenResponse | { data: PairingTokenResponse }>(
      "POST",
      `/api/v1/eliza/agents/${encodePathParam(agentId)}/pairing-token`,
    ).then((response) => ("data" in response ? response.data : response));
  }

  registerGatewayRelaySession(request: {
    runtimeAgentId: string;
    agentName?: string;
  }): Promise<RegisterGatewayRelaySessionResponse> {
    return this.v1.post<RegisterGatewayRelaySessionResponse>(
      "/eliza/gateway-relay/sessions",
      request,
    );
  }

  pollGatewayRelayRequest(
    sessionId: string,
    timeoutMs?: number,
  ): Promise<PollGatewayRelayResponse> {
    return this.v1.get<PollGatewayRelayResponse>(
      `/eliza/gateway-relay/sessions/${encodePathParam(sessionId)}/next`,
      { query: timeoutMs === undefined ? undefined : { timeoutMs } },
    );
  }

  submitGatewayRelayResponse(
    sessionId: string,
    requestId: string,
    response: GatewayRelayResponse,
  ): Promise<{ success: boolean }> {
    return this.v1.post(`/eliza/gateway-relay/sessions/${encodePathParam(sessionId)}/responses`, {
      requestId,
      response,
    });
  }

  disconnectGatewayRelaySession(sessionId: string): Promise<{ success: boolean }> {
    return this.v1.delete(`/eliza/gateway-relay/sessions/${encodePathParam(sessionId)}`);
  }

  getJob(jobId: string): Promise<JobStatus> {
    return this.request("GET", `/api/v1/jobs/${encodePathParam(jobId)}`);
  }

  async pollJob(jobId: string, options: { timeoutMs?: number; intervalMs?: number } = {}) {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const intervalMs = options.intervalMs ?? 2_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const job = await this.getJob(jobId);
      if (job.status === "completed" || job.status === "failed") {
        return job;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(`Timed out waiting for Eliza Cloud job ${jobId}`);
  }

  getUser(): Promise<UserProfileResponse> {
    return this.request("GET", "/api/v1/user");
  }

  updateUser(request: Record<string, unknown>): Promise<UserProfileResponse> {
    return this.request("PATCH", "/api/v1/user", { json: request });
  }

  listApiKeys(): Promise<ApiKeyListResponse> {
    return this.request("GET", "/api/v1/api-keys");
  }

  createApiKey(request: ApiKeyCreateRequest): Promise<ApiKeyCreateResponse> {
    return this.request("POST", "/api/v1/api-keys", { json: request });
  }

  updateApiKey(apiKeyId: string, request: Partial<ApiKeyCreateRequest>) {
    return this.request("PATCH", `/api/v1/api-keys/${encodePathParam(apiKeyId)}`, {
      json: request,
    });
  }

  deleteApiKey(apiKeyId: string): Promise<{ success?: boolean; message?: string }> {
    return this.request("DELETE", `/api/v1/api-keys/${encodePathParam(apiKeyId)}`);
  }

  regenerateApiKey(apiKeyId: string): Promise<ApiKeyCreateResponse> {
    return this.request("POST", `/api/v1/api-keys/${encodePathParam(apiKeyId)}/regenerate`);
  }

  /**
   * Workflow proxy: routes are forwarded to the user's Railway-deployed
   * agent (plugin-workflow). Responses are passed through unchanged; the
   * shape is owned by the agent plugin, not the cloud, so we type as
   * `unknown` here to avoid drift.
   */
  listWorkflows(agentId: string): Promise<unknown> {
    return this.request(
      "GET",
      `/api/v1/agents/${encodePathParam(agentId)}/workflows`,
    );
  }

  createWorkflow(agentId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request(
      "POST",
      `/api/v1/agents/${encodePathParam(agentId)}/workflows`,
      { json: body },
    );
  }

  getWorkflow(agentId: string, workflowId: string): Promise<unknown> {
    return this.request(
      "GET",
      `/api/v1/agents/${encodePathParam(agentId)}/workflows/${encodePathParam(workflowId)}`,
    );
  }

  updateWorkflow(
    agentId: string,
    workflowId: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request(
      "PUT",
      `/api/v1/agents/${encodePathParam(agentId)}/workflows/${encodePathParam(workflowId)}`,
      { json: body },
    );
  }

  deleteWorkflow(agentId: string, workflowId: string): Promise<unknown> {
    return this.request(
      "DELETE",
      `/api/v1/agents/${encodePathParam(agentId)}/workflows/${encodePathParam(workflowId)}`,
    );
  }

  runWorkflow(
    agentId: string,
    workflowId: string,
    body: Record<string, unknown> = {},
  ): Promise<unknown> {
    return this.request(
      "POST",
      `/api/v1/agents/${encodePathParam(agentId)}/workflows/${encodePathParam(workflowId)}/run`,
      { json: body },
    );
  }

  getWorkflowExecution(agentId: string, executionId: string): Promise<unknown> {
    return this.request(
      "GET",
      `/api/v1/agents/${encodePathParam(agentId)}/workflows/executions/${encodePathParam(executionId)}`,
    );
  }
}

export function createElizaCloudClient(options?: ElizaCloudClientOptions): ElizaCloudClient {
  return new ElizaCloudClient(options);
}
