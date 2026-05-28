import { CloudApiClient, ElizaCloudHttpClient } from "./http.js";
import { ElizaCloudPublicRoutesClient } from "./public-routes.js";
import { type AffiliateCodeResponse, type AgentLifecycleResponse, type AgentListResponse, type AgentResponse, type ApiKeyCreateRequest, type ApiKeyCreateResponse, type ApiKeyListResponse, type AppCreditsBalanceResponse, type AppEarningsHistoryResponse, type AppEarningsResponse, type AuthPairResponse, type ChatCompletionRequest, type ChatCompletionResponse, type CliLoginPollResponse, type CliLoginStartOptions, type CliLoginStartResponse, type CloudRequestOptions, type ContainerCredentialsResponse, type ContainerGetResponse, type ContainerHealthResponse, type ContainerListResponse, type ContainerQuotaResponse, type CreateAgentRequest, type CreateAgentResponse, type CreateAppChargeCheckoutRequest, type CreateAppChargeCheckoutResponse, type CreateAppChargeRequest, type CreateAppChargeResponse, type CreateAppCreditsCheckoutRequest, type CreateAppCreditsCheckoutResponse, type CreateContainerRequest, type CreateContainerResponse, type CreateCreditsCheckoutRequest, type CreateCreditsCheckoutResponse, type CreateRedemptionRequest, type CreateRedemptionResponse, type CreateX402PaymentRequest, type CreateX402PaymentRequestResponse, type CreditBalanceResponse, type CreditSummaryResponse, type ElizaCloudClientOptions, type EmbeddingsRequest, type EmbeddingsResponse, type EndpointCallOptions, type GatewayRelayResponse, type GenerateImageRequest, type GenerateImageResponse, type GetAppChargeResponse, type GetX402PaymentRequestResponse, type HttpMethod, type JobStatus, type JsonObject, type LinkAffiliateRequest, type LinkAffiliateResponse, type ListAppChargesResponse, type ListRedemptionsResponse, type ListX402PaymentRequestsResponse, type ModelListResponse, type OpenApiSpec, type PairingTokenResponse, type PollGatewayRelayResponse, type RedemptionBalanceResponse, type RedemptionQuoteResponse, type RedemptionStatusResponse, type RegisterGatewayRelaySessionResponse, type ResponsesCreateRequest, type ResponsesCreateResponse, type SettleX402PaymentRequestResponse, type SnapshotListResponse, type SnapshotType, type UpdateContainerRequest, type UpsertAffiliateCodeRequest, type UserProfileResponse, type VerifyAppCreditsCheckoutResponse, type WithdrawAppEarningsRequest, type WithdrawAppEarningsResponse, type X402FacilitatorPaymentRequest, type X402SettleResponse, type X402SupportedResponse, type X402VerifyResponse } from "./types.js";
export declare class ElizaCloudClient {
    readonly http: ElizaCloudHttpClient;
    readonly v1: CloudApiClient;
    readonly routes: ElizaCloudPublicRoutesClient;
    readonly baseUrl: string;
    readonly apiBaseUrl: string;
    constructor(options?: ElizaCloudClientOptions);
    setApiKey(apiKey: string | undefined): void;
    setBearerToken(token: string | undefined): void;
    request<TResponse>(method: HttpMethod, path: string, options?: CloudRequestOptions): Promise<TResponse>;
    requestRaw(method: HttpMethod, path: string, options?: CloudRequestOptions): Promise<Response>;
    callEndpoint<TResponse>(method: HttpMethod, pathTemplate: string, options?: EndpointCallOptions): Promise<TResponse>;
    getOpenApiSpec(options?: CloudRequestOptions): Promise<OpenApiSpec>;
    startCliLogin(options?: CliLoginStartOptions): Promise<CliLoginStartResponse>;
    pollCliLogin(sessionId: string): Promise<CliLoginPollResponse>;
    pairWithToken(token: string, origin: string): Promise<AuthPairResponse>;
    listModels(): Promise<ModelListResponse>;
    createResponse(request: ResponsesCreateRequest): Promise<ResponsesCreateResponse>;
    createChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
    createEmbeddings(request: EmbeddingsRequest): Promise<EmbeddingsResponse>;
    generateImage(request: GenerateImageRequest): Promise<GenerateImageResponse>;
    getCreditsBalance(options?: {
        fresh?: boolean;
    }): Promise<CreditBalanceResponse>;
    getCreditsSummary(): Promise<CreditSummaryResponse>;
    createCreditsCheckout(request: CreateCreditsCheckoutRequest): Promise<CreateCreditsCheckoutResponse>;
    getAppCreditsBalance(appId: string): Promise<AppCreditsBalanceResponse>;
    createAppCreditsCheckout(request: CreateAppCreditsCheckoutRequest): Promise<CreateAppCreditsCheckoutResponse>;
    verifyAppCreditsCheckout(sessionId: string): Promise<VerifyAppCreditsCheckoutResponse>;
    getX402Supported(): Promise<X402SupportedResponse>;
    verifyX402Payment(request: X402FacilitatorPaymentRequest): Promise<X402VerifyResponse>;
    settleX402Payment(request: X402FacilitatorPaymentRequest): Promise<X402SettleResponse>;
    createX402PaymentRequest(request: CreateX402PaymentRequest): Promise<CreateX402PaymentRequestResponse>;
    listX402PaymentRequests(): Promise<ListX402PaymentRequestsResponse>;
    getX402PaymentRequest(id: string): Promise<GetX402PaymentRequestResponse>;
    settleX402PaymentRequest(id: string, paymentPayload: JsonObject): Promise<SettleX402PaymentRequestResponse>;
    createAppCharge(appId: string, request: CreateAppChargeRequest): Promise<CreateAppChargeResponse>;
    listAppCharges(appId: string, options?: {
        limit?: number;
    }): Promise<ListAppChargesResponse>;
    getAppCharge(appId: string, chargeId: string): Promise<GetAppChargeResponse>;
    createAppChargeCheckout(appId: string, chargeId: string, request: CreateAppChargeCheckoutRequest): Promise<CreateAppChargeCheckoutResponse>;
    getAffiliateCode(): Promise<AffiliateCodeResponse>;
    createAffiliateCode(request: UpsertAffiliateCodeRequest): Promise<AffiliateCodeResponse>;
    updateAffiliateCode(request: UpsertAffiliateCodeRequest): Promise<AffiliateCodeResponse>;
    linkAffiliateCode(request: LinkAffiliateRequest): Promise<LinkAffiliateResponse>;
    getAppEarnings(appId: string, options?: {
        days?: number;
    }): Promise<AppEarningsResponse>;
    getAppEarningsHistory(appId: string, options?: {
        limit?: number;
        offset?: number;
        type?: string;
    }): Promise<AppEarningsHistoryResponse>;
    withdrawAppEarnings(appId: string, request: WithdrawAppEarningsRequest): Promise<WithdrawAppEarningsResponse>;
    getRedemptionBalance(): Promise<RedemptionBalanceResponse>;
    getRedemptionQuote(network: string, pointsAmount?: number): Promise<RedemptionQuoteResponse>;
    getRedemptionStatus(): Promise<RedemptionStatusResponse>;
    createRedemption(request: CreateRedemptionRequest): Promise<CreateRedemptionResponse>;
    listRedemptions(options?: {
        limit?: number;
    }): Promise<ListRedemptionsResponse>;
    listContainers(): Promise<ContainerListResponse>;
    createContainer(request: CreateContainerRequest): Promise<CreateContainerResponse>;
    getContainer(containerId: string): Promise<ContainerGetResponse>;
    updateContainer(containerId: string, request: UpdateContainerRequest): Promise<ContainerGetResponse>;
    deleteContainer(containerId: string): Promise<{
        success: boolean;
        message?: string;
    }>;
    getContainerHealth(containerId: string): Promise<ContainerHealthResponse>;
    getContainerMetrics(containerId: string): Promise<Record<string, unknown>>;
    getContainerLogs(containerId: string, tail?: number): Promise<string>;
    getContainerDeployments(containerId: string): Promise<Record<string, unknown>>;
    getContainerQuota(): Promise<ContainerQuotaResponse>;
    createContainerCredentials(request?: Record<string, unknown>): Promise<ContainerCredentialsResponse>;
    listAgents(): Promise<AgentListResponse>;
    createAgent(request: CreateAgentRequest): Promise<CreateAgentResponse>;
    getAgent(agentId: string): Promise<AgentResponse>;
    updateAgent(agentId: string, request: Partial<CreateAgentRequest>): Promise<AgentResponse>;
    deleteAgent(agentId: string): Promise<AgentLifecycleResponse>;
    provisionAgent(agentId: string): Promise<AgentLifecycleResponse>;
    suspendAgent(agentId: string): Promise<AgentLifecycleResponse>;
    resumeAgent(agentId: string): Promise<AgentLifecycleResponse>;
    createAgentSnapshot(agentId: string, snapshotType?: SnapshotType, metadata?: Record<string, unknown>): Promise<Record<string, unknown>>;
    listAgentBackups(agentId: string): Promise<SnapshotListResponse>;
    restoreAgentBackup(agentId: string, backupId?: string): Promise<Record<string, unknown>>;
    getAgentPairingToken(agentId: string): Promise<PairingTokenResponse>;
    registerGatewayRelaySession(request: {
        runtimeAgentId: string;
        agentName?: string;
    }): Promise<RegisterGatewayRelaySessionResponse>;
    pollGatewayRelayRequest(sessionId: string, timeoutMs?: number): Promise<PollGatewayRelayResponse>;
    submitGatewayRelayResponse(sessionId: string, requestId: string, response: GatewayRelayResponse): Promise<{
        success: boolean;
    }>;
    disconnectGatewayRelaySession(sessionId: string): Promise<{
        success: boolean;
    }>;
    getJob(jobId: string): Promise<JobStatus>;
    pollJob(jobId: string, options?: {
        timeoutMs?: number;
        intervalMs?: number;
    }): Promise<JobStatus>;
    getUser(): Promise<UserProfileResponse>;
    updateUser(request: Record<string, unknown>): Promise<UserProfileResponse>;
    listApiKeys(): Promise<ApiKeyListResponse>;
    createApiKey(request: ApiKeyCreateRequest): Promise<ApiKeyCreateResponse>;
    updateApiKey(apiKeyId: string, request: Partial<ApiKeyCreateRequest>): Promise<unknown>;
    deleteApiKey(apiKeyId: string): Promise<{
        success?: boolean;
        message?: string;
    }>;
    regenerateApiKey(apiKeyId: string): Promise<ApiKeyCreateResponse>;
    /**
     * Workflow proxy: routes are forwarded to the user's Railway-deployed
     * agent (plugin-workflow). Responses are passed through unchanged; the
     * shape is owned by the agent plugin, not the cloud, so we type as
     * `unknown` here to avoid drift.
     */
    listWorkflows(agentId: string): Promise<unknown>;
    createWorkflow(agentId: string, body: Record<string, unknown>): Promise<unknown>;
    getWorkflow(agentId: string, workflowId: string): Promise<unknown>;
    updateWorkflow(agentId: string, workflowId: string, body: Record<string, unknown>): Promise<unknown>;
    deleteWorkflow(agentId: string, workflowId: string): Promise<unknown>;
    runWorkflow(agentId: string, workflowId: string, body?: Record<string, unknown>): Promise<unknown>;
    getWorkflowExecution(agentId: string, executionId: string): Promise<unknown>;
}
export declare function createElizaCloudClient(options?: ElizaCloudClientOptions): ElizaCloudClient;
//# sourceMappingURL=client.d.ts.map