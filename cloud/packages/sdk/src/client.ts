import { CloudApiClient, ElizaCloudHttpClient } from "./http.js";
import { ElizaCloudPublicRoutesClient } from "./public-routes.js";
import {
  type AffiliateCodeResponse,
  type AgentLifecycleResponse,
  type AgentListResponse,
  type AgentResponse,
  type ApiKeyCreateRequest,
  type ApiKeyCreateResponse,
  type ApiKeyListResponse,
  type AppCreditsBalanceResponse,
  type AppEarningsHistoryResponse,
  type AppEarningsResponse,
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
  type CreateAppChargeCheckoutRequest,
  type CreateAppChargeCheckoutResponse,
  type CreateAppChargeRequest,
  type CreateAppChargeResponse,
  type CreateAppCreditsCheckoutRequest,
  type CreateAppCreditsCheckoutResponse,
  type CreateContainerRequest,
  type CreateContainerResponse,
  type CreateCreditsCheckoutRequest,
  type CreateCreditsCheckoutResponse,
  type CreateRedemptionRequest,
  type CreateRedemptionResponse,
  type CreateX402PaymentRequest,
  type CreateX402PaymentRequestResponse,
  type CreditBalanceResponse,
  type CreditSummaryResponse,
  DEFAULT_ELIZA_CLOUD_API_BASE_URL,
  DEFAULT_ELIZA_CLOUD_API_ORIGIN,
  DEFAULT_ELIZA_CLOUD_BASE_URL,
  type ElizaCloudClientOptions,
  type EmbeddingsRequest,
  type EmbeddingsResponse,
  type EndpointCallOptions,
  type GatewayRelayResponse,
  type GenerateImageRequest,
  type GenerateImageResponse,
  type GetAppChargeResponse,
  type GetX402PaymentRequestResponse,
  type HttpMethod,
  type JobStatus,
  type LinkAffiliateRequest,
  type LinkAffiliateResponse,
  type ListAppChargesResponse,
  type ListRedemptionsResponse,
  type ListX402PaymentRequestsResponse,
  type ModelListResponse,
  type OpenApiSpec,
  type PairingTokenResponse,
  type PollGatewayRelayResponse,
  type RedemptionBalanceResponse,
  type RedemptionQuoteResponse,
  type RedemptionStatusResponse,
  type RegisterGatewayRelaySessionResponse,
  type ResponsesCreateRequest,
  type ResponsesCreateResponse,
  type SettleX402PaymentRequestResponse,
  type SnapshotListResponse,
  type SnapshotType,
  type UpdateContainerRequest,
  type UpsertAffiliateCodeRequest,
  type UserProfileResponse,
  type VerifyAppCreditsCheckoutResponse,
  type WithdrawAppEarningsRequest,
  type WithdrawAppEarningsResponse,
  type X402FacilitatorPaymentRequest,
  type X402SettleResponse,
  type X402SupportedResponse,
  type X402VerifyResponse,
} from "./types.js";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeBaseUrl(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimTrailingSlash(trimmed && trimmed.length > 0 ? trimmed : fallback);
}

function apiOriginFromApiBaseUrl(value: string): string {
  return value.replace(/\/api\/v1\/?$/, "");
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
    this.apiBaseUrl = normalizeBaseUrl(
      options.apiBaseUrl,
      options.baseUrl ? `${this.baseUrl}/api/v1` : DEFAULT_ELIZA_CLOUD_API_BASE_URL,
    );
    const apiOrigin = options.apiBaseUrl
      ? apiOriginFromApiBaseUrl(this.apiBaseUrl)
      : options.baseUrl
        ? this.baseUrl
        : DEFAULT_ELIZA_CLOUD_API_ORIGIN;
    this.http = new ElizaCloudHttpClient({
      ...options,
      baseUrl: apiOrigin,
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

  createCreditsCheckout(
    request: CreateCreditsCheckoutRequest,
  ): Promise<CreateCreditsCheckoutResponse> {
    return this.request<CreateCreditsCheckoutResponse>("POST", "/api/v1/credits/checkout", {
      json: request,
    });
  }

  getAppCreditsBalance(appId: string): Promise<AppCreditsBalanceResponse> {
    return this.request<AppCreditsBalanceResponse>("GET", "/api/v1/app-credits/balance", {
      query: { app_id: appId },
    });
  }

  createAppCreditsCheckout(
    request: CreateAppCreditsCheckoutRequest,
  ): Promise<CreateAppCreditsCheckoutResponse> {
    return this.request<CreateAppCreditsCheckoutResponse>("POST", "/api/v1/app-credits/checkout", {
      json: request,
    });
  }

  verifyAppCreditsCheckout(sessionId: string): Promise<VerifyAppCreditsCheckoutResponse> {
    return this.request<VerifyAppCreditsCheckoutResponse>("GET", "/api/v1/app-credits/verify", {
      query: { session_id: sessionId },
    });
  }

  getX402Supported(): Promise<X402SupportedResponse> {
    return this.request<X402SupportedResponse>("GET", "/api/v1/x402", { skipAuth: true });
  }

  verifyX402Payment(request: X402FacilitatorPaymentRequest): Promise<X402VerifyResponse> {
    return this.request<X402VerifyResponse>("POST", "/api/v1/x402/verify", {
      json: request,
      skipAuth: true,
    });
  }

  settleX402Payment(request: X402FacilitatorPaymentRequest): Promise<X402SettleResponse> {
    return this.request<X402SettleResponse>("POST", "/api/v1/x402/settle", {
      json: request,
      skipAuth: true,
    });
  }

  createX402PaymentRequest(
    request: CreateX402PaymentRequest,
  ): Promise<CreateX402PaymentRequestResponse> {
    return this.request<CreateX402PaymentRequestResponse>("POST", "/api/v1/x402/requests", {
      json: request,
    });
  }

  listX402PaymentRequests(): Promise<ListX402PaymentRequestsResponse> {
    return this.request<ListX402PaymentRequestsResponse>("GET", "/api/v1/x402/requests");
  }

  getX402PaymentRequest(id: string): Promise<GetX402PaymentRequestResponse> {
    return this.request<GetX402PaymentRequestResponse>(
      "GET",
      `/api/v1/x402/requests/${encodePathParam(id)}`,
      { skipAuth: true },
    );
  }

  settleX402PaymentRequest(
    id: string,
    paymentPayload: unknown,
  ): Promise<SettleX402PaymentRequestResponse> {
    return this.request<SettleX402PaymentRequestResponse>(
      "POST",
      `/api/v1/x402/requests/${encodePathParam(id)}/settle`,
      { json: { paymentPayload }, skipAuth: true },
    );
  }

  createAppCharge(
    appId: string,
    request: CreateAppChargeRequest,
  ): Promise<CreateAppChargeResponse> {
    return this.request<CreateAppChargeResponse>(
      "POST",
      `/api/v1/apps/${encodePathParam(appId)}/charges`,
      { json: request },
    );
  }

  listAppCharges(appId: string, options: { limit?: number } = {}): Promise<ListAppChargesResponse> {
    return this.request<ListAppChargesResponse>(
      "GET",
      `/api/v1/apps/${encodePathParam(appId)}/charges`,
      { query: options.limit === undefined ? undefined : { limit: options.limit } },
    );
  }

  getAppCharge(appId: string, chargeId: string): Promise<GetAppChargeResponse> {
    return this.request<GetAppChargeResponse>(
      "GET",
      `/api/v1/apps/${encodePathParam(appId)}/charges/${encodePathParam(chargeId)}`,
      { skipAuth: true },
    );
  }

  createAppChargeCheckout(
    appId: string,
    chargeId: string,
    request: CreateAppChargeCheckoutRequest,
  ): Promise<CreateAppChargeCheckoutResponse> {
    return this.request<CreateAppChargeCheckoutResponse>(
      "POST",
      `/api/v1/apps/${encodePathParam(appId)}/charges/${encodePathParam(chargeId)}/checkout`,
      { json: request },
    );
  }

  getAffiliateCode(): Promise<AffiliateCodeResponse> {
    return this.request<AffiliateCodeResponse>("GET", "/api/v1/affiliates");
  }

  createAffiliateCode(request: UpsertAffiliateCodeRequest): Promise<AffiliateCodeResponse> {
    return this.request<AffiliateCodeResponse>("POST", "/api/v1/affiliates", { json: request });
  }

  updateAffiliateCode(request: UpsertAffiliateCodeRequest): Promise<AffiliateCodeResponse> {
    return this.request<AffiliateCodeResponse>("PUT", "/api/v1/affiliates", { json: request });
  }

  linkAffiliateCode(request: LinkAffiliateRequest): Promise<LinkAffiliateResponse> {
    return this.request<LinkAffiliateResponse>("POST", "/api/v1/affiliates/link", {
      json: request,
    });
  }

  getAppEarnings(appId: string, options: { days?: number } = {}): Promise<AppEarningsResponse> {
    return this.request<AppEarningsResponse>(
      "GET",
      `/api/v1/apps/${encodePathParam(appId)}/earnings`,
      { query: options.days === undefined ? undefined : { days: options.days } },
    );
  }

  getAppEarningsHistory(
    appId: string,
    options: { limit?: number; offset?: number; type?: string } = {},
  ): Promise<AppEarningsHistoryResponse> {
    return this.request<AppEarningsHistoryResponse>(
      "GET",
      `/api/v1/apps/${encodePathParam(appId)}/earnings/history`,
      { query: options },
    );
  }

  withdrawAppEarnings(
    appId: string,
    request: WithdrawAppEarningsRequest,
  ): Promise<WithdrawAppEarningsResponse> {
    return this.request<WithdrawAppEarningsResponse>(
      "POST",
      `/api/v1/apps/${encodePathParam(appId)}/earnings/withdraw`,
      { json: request },
    );
  }

  getRedemptionBalance(): Promise<RedemptionBalanceResponse> {
    return this.request<RedemptionBalanceResponse>("GET", "/api/v1/redemptions/balance");
  }

  getRedemptionQuote(network: string, pointsAmount?: number): Promise<RedemptionQuoteResponse> {
    return this.request<RedemptionQuoteResponse>("GET", "/api/v1/redemptions/quote", {
      query: { network, pointsAmount },
    });
  }

  getRedemptionStatus(): Promise<RedemptionStatusResponse> {
    return this.request<RedemptionStatusResponse>("GET", "/api/v1/redemptions/status", {
      skipAuth: true,
    });
  }

  createRedemption(request: CreateRedemptionRequest): Promise<CreateRedemptionResponse> {
    return this.request<CreateRedemptionResponse>("POST", "/api/v1/redemptions", {
      json: request,
    });
  }

  listRedemptions(options: { limit?: number } = {}): Promise<ListRedemptionsResponse> {
    return this.request<ListRedemptionsResponse>("GET", "/api/v1/redemptions", {
      query: options.limit === undefined ? undefined : { limit: options.limit },
    });
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
    return this.request("GET", `/api/v1/agents/${encodePathParam(agentId)}/workflows`);
  }

  createWorkflow(agentId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", `/api/v1/agents/${encodePathParam(agentId)}/workflows`, {
      json: body,
    });
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
