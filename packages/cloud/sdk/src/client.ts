import { CloudApiClient, CloudApiError, ElizaCloudHttpClient } from "./http.js";
import { ElizaCloudPublicRoutesClient } from "./public-routes.js";
import {
  type ActivateAppFrontendResponse,
  type AdCampaignAttributionResponse,
  type AffiliateCodeResponse,
  type AgentLifecycleResponse,
  type AgentListResponse,
  type AgentResponse,
  type ApiKeyCreateRequest,
  type ApiKeyCreateResponse,
  type ApiKeyListResponse,
  type AppBackupSnapshot,
  type AppCreditsBalanceResponse,
  type AppDeployStatusResponse,
  type AppDomainStatusInput,
  type AppDomainStatusResponse,
  type AppEarningsHistoryResponse,
  type AppEarningsResponse,
  type AppMonetizationResponse,
  type AppResponse,
  type AuthPairResponse,
  type BuyAppDomainInput,
  type BuyAppDomainResponse,
  type CampaignDaypartingResponse,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type CheckAppDomainInput,
  type CheckAppDomainResponse,
  type CliLoginPollResponse,
  type CliLoginStartOptions,
  type CliLoginStartResponse,
  type CloudRequestOptions,
  type ContainerCredentialsResponse,
  type ContainerGetResponse,
  type ContainerHealthResponse,
  type ContainerListResponse,
  type ContainerQuotaResponse,
  type CreateAdSlotInput,
  type CreateAdSlotResponse,
  type CreateAgentRequest,
  type CreateAgentResponse,
  type CreateAppChargeCheckoutRequest,
  type CreateAppChargeCheckoutResponse,
  type CreateAppChargeRequest,
  type CreateAppChargeResponse,
  type CreateAppCreditsCheckoutRequest,
  type CreateAppCreditsCheckoutResponse,
  type CreateAppInput,
  type CreateAppResponse,
  type CreateBookingInput,
  type CreateBookingResponse,
  type CreateContainerRequest,
  type CreateContainerResponse,
  type CreateCreditsCheckoutRequest,
  type CreateCreditsCheckoutResponse,
  type CreateInfluencerProfileInput,
  type CreateInfluencerProfileResponse,
  type CreateRedemptionRequest,
  type CreateRedemptionResponse,
  type CreateX402PaymentRequest,
  type CreateX402PaymentRequestResponse,
  type CreditBalanceResponse,
  type CreditSummaryResponse,
  DEFAULT_ELIZA_CLOUD_API_BASE_URL,
  DEFAULT_ELIZA_CLOUD_API_ORIGIN,
  DEFAULT_ELIZA_CLOUD_BASE_URL,
  type DeleteAppResponse,
  type DeployAppFrontendInput,
  type DeployAppFrontendResponse,
  type DeployAppInput,
  type DeployAppResponse,
  type DuplicateAdCampaignInput,
  type DuplicateAdCampaignResponse,
  type ElizaCloudClientOptions,
  type EmbeddingsRequest,
  type EmbeddingsResponse,
  type EndpointCallOptions,
  type ExportAppBackupResponse,
  type GatewayRelayResponse,
  type GenerateImageRequest,
  type GenerateImageResponse,
  type GetAppChargeResponse,
  type GetX402PaymentRequestResponse,
  type HttpMethod,
  type JobStatus,
  type JsonObject,
  type LinkAffiliateRequest,
  type LinkAffiliateResponse,
  type ListAdSlotsResponse,
  type ListAppChargesResponse,
  type ListAppDomainsResponse,
  type ListAppFrontendDeploymentsResponse,
  type ListAppsResponse,
  type ListInfluencersResponse,
  type ListRedemptionsResponse,
  type ListX402PaymentRequestsResponse,
  type ModelListResponse,
  type OpenApiSpec,
  type PairingTokenResponse,
  type PollGatewayRelayResponse,
  type RedemptionBalanceResponse,
  type RedemptionQuoteResponse,
  type RedemptionStatusResponse,
  type RegenerateAppApiKeyResponse,
  type RegisterGatewayRelaySessionResponse,
  type ResponsesCreateRequest,
  type ResponsesCreateResponse,
  type RestoreAppBackupResponse,
  type SettleX402PaymentRequestResponse,
  type SnapshotListResponse,
  type SnapshotType,
  type UpdateAppInput,
  type UpdateAppMonetizationInput,
  type UpdateCampaignDaypartingInput,
  type UpdateContainerRequest,
  type UpsertAffiliateCodeRequest,
  type UserProfileResponse,
  type VerifyAppCreditsCheckoutResponse,
  type VoiceSttRequest,
  type VoiceSttResponse,
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
  return new URL(value).origin;
}

function normalizeCloudApiBaseUrl(
  value: string | undefined,
  fallback: string,
): string {
  const baseUrl = normalizeBaseUrl(value, fallback);
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid Eliza Cloud API base URL: ${baseUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Invalid Eliza Cloud API base URL protocol: ${baseUrl}`);
  }
  if (url.search || url.hash) {
    throw new Error(
      `Eliza Cloud API base URL must not include query or hash: ${baseUrl}`,
    );
  }

  const pathname = trimTrailingSlash(url.pathname);
  if (!pathname || pathname === "/") {
    url.pathname = "/api/v1";
  } else if (pathname === "/api/v1") {
    url.pathname = "/api/v1";
  } else {
    throw new Error(
      `Eliza Cloud API base URL must be an origin or end at /api/v1: ${baseUrl}`,
    );
  }
  return trimTrailingSlash(url.toString());
}

function browserBaseUrlForCliLogin(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (url.hostname.toLowerCase() === "api.elizacloud.ai") {
      return DEFAULT_ELIZA_CLOUD_BASE_URL;
    }
  } catch {
    // Fall through to the configured base URL.
  }
  return baseUrl;
}

function encodePathParam(value: string | number): string {
  return encodeURIComponent(String(value));
}

/** Per-call options for the inference methods (chat/responses/embeddings/image). */
export interface InferenceCallOptions {
  /**
   * Bill this request to a registered Eliza Cloud app's credits by sending the
   * `X-App-Id` header. The app owner earns the configured markup. Omit to bill
   * the caller's own org/personal credits.
   */
  appId?: string;
  /**
   * Attribute this request to an affiliate for revenue share by sending the
   * `X-Affiliate-Code` header. Read by the credit-billed inference routes
   * (chat/completions, embeddings, voice); routes without affiliate billing
   * ignore it. Omit when no affiliate applies.
   */
  affiliateCode?: string;
}

/**
 * Build the request headers for an inference call: `X-App-Id` (app billing +
 * creator markup) and `X-Affiliate-Code` (affiliate revenue share). Each is
 * sent only when set, so a plain call carries neither.
 */
function inferenceRequestOptions(options: InferenceCallOptions): {
  headers?: Record<string, string>;
} {
  const headers: Record<string, string> = {};
  if (options.appId) headers["X-App-Id"] = options.appId;
  if (options.affiliateCode)
    headers["X-Affiliate-Code"] = options.affiliateCode;
  return Object.keys(headers).length > 0 ? { headers } : {};
}

function withPathParams(
  path: string,
  params?: Record<string, string | number>,
): string {
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
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl,
      DEFAULT_ELIZA_CLOUD_BASE_URL,
    );
    this.apiBaseUrl = normalizeCloudApiBaseUrl(
      options.apiBaseUrl,
      options.baseUrl
        ? `${this.baseUrl}/api/v1`
        : DEFAULT_ELIZA_CLOUD_API_BASE_URL,
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

  requestRaw(
    method: HttpMethod,
    path: string,
    options?: CloudRequestOptions,
  ): Promise<Response> {
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

  startCliLogin(
    options: CliLoginStartOptions = {},
  ): Promise<CliLoginStartResponse> {
    const sessionId = options.sessionId ?? getCryptoRandomUuid();
    const query = options.returnTo
      ? `?returnTo=${encodeURIComponent(options.returnTo)}`
      : "";
    const browserBaseUrl = browserBaseUrlForCliLogin(this.baseUrl);
    const browserUrl = `${browserBaseUrl}/auth/cli-login?session=${encodeURIComponent(
      sessionId,
    )}${query}`;

    return this.request<{ status?: string; expiresAt?: string }>(
      "POST",
      "/api/auth/cli-session",
      {
        json: { sessionId },
        skipAuth: true,
      },
    ).then((response) => ({
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

  /**
   * Poll a CLI/web login session until it resolves. Returns the authenticated
   * response (with `apiKey`/`userId`) as soon as the user authorizes, or throws
   * on expiry/error/timeout. Saves every web integration from re-implementing
   * the deadline + interval + terminal-status loop around {@link pollCliLogin}.
   *
   * Typical web flow:
   * ```ts
   * const { sessionId, browserUrl } = await cloud.startCliLogin();
   * window.open(browserUrl, "_blank");
   * const { apiKey } = await cloud.waitForCliLogin(sessionId);
   * cloud.setApiKey(apiKey!);
   * ```
   */
  async waitForCliLogin(
    sessionId: string,
    options: {
      timeoutMs?: number;
      intervalMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<CliLoginPollResponse> {
    const timeoutMs = options.timeoutMs ?? 300_000;
    const intervalMs = options.intervalMs ?? 2_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (options.signal?.aborted) {
        throw new Error("Eliza Cloud sign-in was cancelled");
      }
      const result = await this.pollCliLogin(sessionId);
      if (result.status === "authenticated") {
        return result;
      }
      if (result.status === "expired" || result.status === "error") {
        throw new Error(result.error ?? `Eliza Cloud sign-in ${result.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error("Timed out waiting for Eliza Cloud sign-in");
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

  createResponse(
    request: ResponsesCreateRequest,
    options: InferenceCallOptions = {},
  ): Promise<ResponsesCreateResponse> {
    return this.v1.post<ResponsesCreateResponse>(
      "/responses",
      request,
      inferenceRequestOptions(options),
    );
  }

  createChatCompletion(
    request: ChatCompletionRequest,
    options: InferenceCallOptions = {},
  ): Promise<ChatCompletionResponse> {
    return this.v1.post<ChatCompletionResponse>(
      "/chat/completions",
      request,
      inferenceRequestOptions(options),
    );
  }

  createEmbeddings(
    request: EmbeddingsRequest,
    options: InferenceCallOptions = {},
  ): Promise<EmbeddingsResponse> {
    return this.v1.post<EmbeddingsResponse>(
      "/embeddings",
      request,
      inferenceRequestOptions(options),
    );
  }

  generateImage(
    request: GenerateImageRequest,
    options: InferenceCallOptions = {},
  ): Promise<GenerateImageResponse> {
    return this.v1.post<GenerateImageResponse>(
      "/generate-image",
      request,
      inferenceRequestOptions(options),
    );
  }

  /**
   * Transcribe audio to text via POST /api/v1/voice/stt (multipart/form-data).
   *
   * Mirrors {@link createEmbeddings}/{@link generateImage}: routed through the
   * v1 client with auth headers applied automatically, and `options.appId`
   * bills a registered app's credits via the `X-App-Id` header. The audio is
   * sent as a FormData `audio` field; Content-Type is intentionally left unset
   * so the runtime fetch fills in the multipart boundary.
   */
  transcribeAudio(
    request: VoiceSttRequest,
    options: InferenceCallOptions = {},
  ): Promise<VoiceSttResponse> {
    const form = new FormData();
    form.append("audio", request.audio, request.filename ?? "audio");
    if (request.languageCode !== undefined) {
      form.append("languageCode", request.languageCode);
    }
    return this.v1.request<VoiceSttResponse>("POST", "/voice/stt", {
      ...inferenceRequestOptions(options),
      body: form,
    });
  }

  getCreditsBalance(
    options: { fresh?: boolean } = {},
  ): Promise<CreditBalanceResponse> {
    return this.request<CreditBalanceResponse>(
      "GET",
      "/api/v1/credits/balance",
      {
        query:
          options.fresh === undefined ? undefined : { fresh: options.fresh },
      },
    );
  }

  getCreditsSummary(): Promise<CreditSummaryResponse> {
    return this.request<CreditSummaryResponse>(
      "GET",
      "/api/v1/credits/summary",
    );
  }

  createCreditsCheckout(
    request: CreateCreditsCheckoutRequest,
  ): Promise<CreateCreditsCheckoutResponse> {
    return this.request<CreateCreditsCheckoutResponse>(
      "POST",
      "/api/v1/credits/checkout",
      {
        json: request,
      },
    );
  }

  getAppCreditsBalance(appId: string): Promise<AppCreditsBalanceResponse> {
    return this.request<AppCreditsBalanceResponse>(
      "GET",
      "/api/v1/app-credits/balance",
      {
        query: { app_id: appId },
      },
    );
  }

  createAppCreditsCheckout(
    request: CreateAppCreditsCheckoutRequest,
  ): Promise<CreateAppCreditsCheckoutResponse> {
    return this.request<CreateAppCreditsCheckoutResponse>(
      "POST",
      "/api/v1/app-credits/checkout",
      {
        json: request,
      },
    );
  }

  verifyAppCreditsCheckout(
    sessionId: string,
  ): Promise<VerifyAppCreditsCheckoutResponse> {
    return this.request<VerifyAppCreditsCheckoutResponse>(
      "GET",
      "/api/v1/app-credits/verify",
      {
        query: { session_id: sessionId },
      },
    );
  }

  getX402Supported(): Promise<X402SupportedResponse> {
    return this.request<X402SupportedResponse>("GET", "/api/v1/x402", {
      skipAuth: true,
    });
  }

  verifyX402Payment(
    request: X402FacilitatorPaymentRequest,
  ): Promise<X402VerifyResponse> {
    return this.request<X402VerifyResponse>("POST", "/api/v1/x402/verify", {
      json: request,
      skipAuth: true,
    });
  }

  settleX402Payment(
    request: X402FacilitatorPaymentRequest,
  ): Promise<X402SettleResponse> {
    return this.request<X402SettleResponse>("POST", "/api/v1/x402/settle", {
      json: request,
      skipAuth: true,
    });
  }

  createX402PaymentRequest(
    request: CreateX402PaymentRequest,
  ): Promise<CreateX402PaymentRequestResponse> {
    return this.request<CreateX402PaymentRequestResponse>(
      "POST",
      "/api/v1/x402/requests",
      {
        json: request,
      },
    );
  }

  listX402PaymentRequests(): Promise<ListX402PaymentRequestsResponse> {
    return this.request<ListX402PaymentRequestsResponse>(
      "GET",
      "/api/v1/x402/requests",
    );
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
    paymentPayload: JsonObject,
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

  listAppCharges(
    appId: string,
    options: { limit?: number } = {},
  ): Promise<ListAppChargesResponse> {
    return this.request<ListAppChargesResponse>(
      "GET",
      `/api/v1/apps/${encodePathParam(appId)}/charges`,
      {
        query:
          options.limit === undefined ? undefined : { limit: options.limit },
      },
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

  createAffiliateCode(
    request: UpsertAffiliateCodeRequest,
  ): Promise<AffiliateCodeResponse> {
    return this.request<AffiliateCodeResponse>("POST", "/api/v1/affiliates", {
      json: request,
    });
  }

  updateAffiliateCode(
    request: UpsertAffiliateCodeRequest,
  ): Promise<AffiliateCodeResponse> {
    return this.request<AffiliateCodeResponse>("PUT", "/api/v1/affiliates", {
      json: request,
    });
  }

  linkAffiliateCode(
    request: LinkAffiliateRequest,
  ): Promise<LinkAffiliateResponse> {
    return this.request<LinkAffiliateResponse>(
      "POST",
      "/api/v1/affiliates/link",
      {
        json: request,
      },
    );
  }

  getAppEarnings(
    appId: string,
    options: { days?: number } = {},
  ): Promise<AppEarningsResponse> {
    return this.request<AppEarningsResponse>(
      "GET",
      `/api/v1/apps/${encodePathParam(appId)}/earnings`,
      {
        query: options.days === undefined ? undefined : { days: options.days },
      },
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
    return this.request<RedemptionBalanceResponse>(
      "GET",
      "/api/v1/redemptions/balance",
    );
  }

  getRedemptionQuote(
    network: string,
    pointsAmount?: number,
  ): Promise<RedemptionQuoteResponse> {
    return this.request<RedemptionQuoteResponse>(
      "GET",
      "/api/v1/redemptions/quote",
      {
        query: { network, pointsAmount },
      },
    );
  }

  getRedemptionStatus(): Promise<RedemptionStatusResponse> {
    return this.request<RedemptionStatusResponse>(
      "GET",
      "/api/v1/redemptions/status",
      {
        skipAuth: true,
      },
    );
  }

  createRedemption(
    request: CreateRedemptionRequest,
  ): Promise<CreateRedemptionResponse> {
    return this.request<CreateRedemptionResponse>(
      "POST",
      "/api/v1/redemptions",
      {
        json: request,
      },
    );
  }

  listRedemptions(
    options: { limit?: number } = {},
  ): Promise<ListRedemptionsResponse> {
    return this.request<ListRedemptionsResponse>("GET", "/api/v1/redemptions", {
      query: options.limit === undefined ? undefined : { limit: options.limit },
    });
  }

  // ─── Apps (Eliza Cloud Apps product) ──────────────────────────────────────
  // Typed wrappers over the generated `routes.*` app endpoints. These are the
  // foundation the agent plugin builds on: every method returns a concrete DTO
  // (no `unknown` in the public signature) and targets the same route + verb the
  // server exposes.

  /** `GET /api/v1/apps` — list apps for the authenticated org. */
  listApps(): Promise<ListAppsResponse> {
    return this.routes.getApiV1Apps<ListAppsResponse>();
  }

  /** `GET /api/v1/apps/:id` — fetch a single app. */
  getApp(appId: string): Promise<AppResponse> {
    return this.routes.getApiV1AppsById<AppResponse>({
      pathParams: { id: appId },
    });
  }

  /** `POST /api/v1/apps` — create an app (provisions its API key + optional repo). */
  createApp(input: CreateAppInput): Promise<CreateAppResponse> {
    return this.routes.postApiV1Apps<CreateAppResponse>({ json: input });
  }

  /** `PATCH /api/v1/apps/:id` — partially update an app. */
  updateApp(appId: string, patch: UpdateAppInput): Promise<AppResponse> {
    return this.routes.patchApiV1AppsById<AppResponse>({
      pathParams: { id: appId },
      json: patch,
    });
  }

  /** `PUT /api/v1/apps/:id/monetization` — update an app's monetization settings. */
  updateMonetization(
    appId: string,
    settings: UpdateAppMonetizationInput,
  ): Promise<AppMonetizationResponse> {
    return this.routes.putApiV1AppsByIdMonetization<AppMonetizationResponse>({
      pathParams: { id: appId },
      json: settings,
    });
  }

  /**
   * `POST /api/v1/apps/:id/deploy` — kick off a container deploy (202 Accepted).
   * Body is optional: defaults pull from the app's linked repo + stored env.
   */
  deployApp(
    appId: string,
    input: DeployAppInput = {},
  ): Promise<DeployAppResponse> {
    return this.routes.postApiV1AppsByIdDeploy<DeployAppResponse>({
      pathParams: { id: appId },
      json: input,
    });
  }

  /** `GET /api/v1/apps/:id/deploy/status` — latest deploy status (poll target). */
  getAppDeployStatus(appId: string): Promise<AppDeployStatusResponse> {
    return this.routes.getApiV1AppsByIdDeployStatus<AppDeployStatusResponse>({
      pathParams: { id: appId },
    });
  }

  /**
   * `POST /api/v1/apps/:id/frontend` — publish a managed static-site bundle
   * (create → content-address files to R2 → finalize manifest → activate) in
   * one call. Returns the (by default active) deployment. The site is then
   * served with SEO + page analytics at the app's frontend host / custom domain.
   */
  deployAppFrontend(
    appId: string,
    input: DeployAppFrontendInput,
  ): Promise<DeployAppFrontendResponse> {
    return this.request<DeployAppFrontendResponse>(
      "POST",
      `/api/v1/apps/${encodeURIComponent(appId)}/frontend`,
      { json: input },
    );
  }

  /** `GET /api/v1/apps/:id/frontend` — list frontend deployments + the active id. */
  listAppFrontendDeployments(
    appId: string,
  ): Promise<ListAppFrontendDeploymentsResponse> {
    return this.request<ListAppFrontendDeploymentsResponse>(
      "GET",
      `/api/v1/apps/${encodeURIComponent(appId)}/frontend`,
    );
  }

  /**
   * `POST /api/v1/apps/:id/frontend/:deploymentId/activate` — make a deployment
   * the live one. Activating an older deployment is a rollback.
   */
  activateAppFrontend(
    appId: string,
    deploymentId: string,
  ): Promise<ActivateAppFrontendResponse> {
    return this.request<ActivateAppFrontendResponse>(
      "POST",
      `/api/v1/apps/${encodeURIComponent(appId)}/frontend/${encodeURIComponent(deploymentId)}/activate`,
    );
  }

  /** `DELETE /api/v1/apps/:id` — delete an app and clean up its resources. */
  deleteApp(appId: string): Promise<DeleteAppResponse> {
    return this.routes.deleteApiV1AppsById<DeleteAppResponse>({
      pathParams: { id: appId },
    });
  }

  /**
   * `POST /api/v1/apps/:id/regenerate-api-key` — rotate the app's API key.
   *
   * SECURITY-SENSITIVE: the previous key is invalidated immediately and the new
   * plaintext key is returned ONCE in the response (`apiKey`). Surface it to the
   * user a single time and never log or persist it.
   */
  regenerateAppApiKey(appId: string): Promise<RegenerateAppApiKeyResponse> {
    return this.routes.postApiV1AppsByIdRegenerateApiKey<RegenerateAppApiKeyResponse>(
      { pathParams: { id: appId } },
    );
  }

  /**
   * `POST /api/v1/apps/:id/domains/check` — availability + marked-up price
   * quote (including the annual renewal price) for a domain. A dry run: never
   * charges and never registers.
   */
  checkAppDomain(
    appId: string,
    input: CheckAppDomainInput,
  ): Promise<CheckAppDomainResponse> {
    return this.routes.postApiV1AppsByIdDomainsCheck<CheckAppDomainResponse>({
      pathParams: { id: appId },
      json: input,
    });
  }

  /**
   * `POST /api/v1/apps/:id/domains/buy` — buy + attach a custom domain via the
   * Cloudflare registrar. Charged from the org credit balance and fails closed
   * (402) before any registration. Idempotency is server-side (per org+domain,
   * 24h window): a retry replays the earlier success instead of re-charging,
   * and an interrupted charged-but-unassigned purchase is recovered without a
   * new charge — see the {@link BuyAppDomainResponse} branches.
   */
  buyAppDomain(
    appId: string,
    input: BuyAppDomainInput,
  ): Promise<BuyAppDomainResponse> {
    return this.routes.postApiV1AppsByIdDomainsBuy<BuyAppDomainResponse>({
      pathParams: { id: appId },
      json: input,
    });
  }

  /** `GET /api/v1/apps/:id/domains` — list the app's attached domains. */
  listAppDomains(appId: string): Promise<ListAppDomainsResponse> {
    return this.routes.getApiV1AppsByIdDomains<ListAppDomainsResponse>({
      pathParams: { id: appId },
    });
  }

  /**
   * `POST /api/v1/apps/:id/domains/status` — verification + SSL status for one
   * attached domain, with live registrar status for cloudflare-registered ones.
   */
  getAppDomainStatus(
    appId: string,
    input: AppDomainStatusInput,
  ): Promise<AppDomainStatusResponse> {
    return this.routes.postApiV1AppsByIdDomainsStatus<AppDomainStatusResponse>({
      pathParams: { id: appId },
      json: input,
    });
  }

  listContainers(): Promise<ContainerListResponse> {
    return this.request<ContainerListResponse>("GET", "/api/v1/containers");
  }

  /**
   * `POST /api/v1/marketing/inventory` — create an ad slot so an app can earn
   * from serving ads on its surface (SSP, #10687).
   */
  createAdSlot(input: CreateAdSlotInput): Promise<CreateAdSlotResponse> {
    return this.request<CreateAdSlotResponse>(
      "POST",
      "/api/v1/marketing/inventory",
      {
        json: input,
      },
    );
  }

  /** `GET /api/v1/marketing/inventory` — list the org's ad slots. */
  listAdSlots(): Promise<ListAdSlotsResponse> {
    return this.request<ListAdSlotsResponse>(
      "GET",
      "/api/v1/marketing/inventory",
    );
  }

  /** `GET /api/v1/advertising/campaigns/:id/dayparting` — read a campaign's delivery windows. */
  getAdCampaignDayparting(
    campaignId: string,
  ): Promise<CampaignDaypartingResponse> {
    return this.request<CampaignDaypartingResponse>(
      "GET",
      `/api/v1/advertising/campaigns/${encodeURIComponent(campaignId)}/dayparting`,
    );
  }

  /** `PUT /api/v1/advertising/campaigns/:id/dayparting` — replace or clear delivery windows. */
  updateAdCampaignDayparting(
    campaignId: string,
    input: UpdateCampaignDaypartingInput,
  ): Promise<CampaignDaypartingResponse> {
    return this.request<CampaignDaypartingResponse>(
      "PUT",
      `/api/v1/advertising/campaigns/${encodeURIComponent(campaignId)}/dayparting`,
      { json: input },
    );
  }

  /** `POST /api/v1/advertising/campaigns/:id/duplicate` — duplicate campaign config locally. */
  duplicateAdCampaign(
    campaignId: string,
    input: DuplicateAdCampaignInput = {},
  ): Promise<DuplicateAdCampaignResponse> {
    return this.request<DuplicateAdCampaignResponse>(
      "POST",
      `/api/v1/advertising/campaigns/${encodeURIComponent(campaignId)}/duplicate`,
      { json: input },
    );
  }

  /** `GET /api/v1/advertising/campaigns/:id/attribution` — signed pixel/webhook install contract. */
  getAdCampaignAttribution(
    campaignId: string,
  ): Promise<AdCampaignAttributionResponse> {
    return this.request<AdCampaignAttributionResponse>(
      "GET",
      `/api/v1/advertising/campaigns/${encodePathParam(campaignId)}/attribution`,
    );
  }

  /** `POST /api/v1/marketing/influencers` — publish an influencer profile to earn from bookings (#10687). */
  createInfluencerProfile(
    input: CreateInfluencerProfileInput,
  ): Promise<CreateInfluencerProfileResponse> {
    return this.request<CreateInfluencerProfileResponse>(
      "POST",
      "/api/v1/marketing/influencers",
      {
        json: input,
      },
    );
  }

  /** `GET /api/v1/marketing/influencers` — browse active influencer profiles. */
  listInfluencers(niche?: string): Promise<ListInfluencersResponse> {
    const q = niche ? `?niche=${encodeURIComponent(niche)}` : "";
    return this.request<ListInfluencersResponse>(
      "GET",
      `/api/v1/marketing/influencers${q}`,
    );
  }

  /** `POST /api/v1/marketing/influencers/bookings` — fund an escrowed influencer booking (#10687). */
  createBooking(input: CreateBookingInput): Promise<CreateBookingResponse> {
    return this.request<CreateBookingResponse>(
      "POST",
      "/api/v1/marketing/influencers/bookings",
      {
        json: input,
      },
    );
  }

  /** `GET /api/v1/apps/:id/backup` — export a secret-free app config snapshot (#10204). */
  exportAppBackup(appId: string): Promise<ExportAppBackupResponse> {
    return this.request<ExportAppBackupResponse>(
      "GET",
      `/api/v1/apps/${appId}/backup`,
    );
  }

  /** `POST /api/v1/apps/backup/restore` — recreate an app from a backup snapshot. */
  restoreAppBackup(
    backup: AppBackupSnapshot,
    name?: string,
  ): Promise<RestoreAppBackupResponse> {
    return this.request<RestoreAppBackupResponse>(
      "POST",
      "/api/v1/apps/backup/restore",
      {
        json: name ? { backup, name } : { backup },
      },
    );
  }

  createContainer(
    request: CreateContainerRequest,
  ): Promise<CreateContainerResponse> {
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

  deleteContainer(
    containerId: string,
  ): Promise<{ success: boolean; message?: string }> {
    return this.request(
      "DELETE",
      `/api/v1/containers/${encodePathParam(containerId)}`,
    );
  }

  getContainerHealth(containerId: string): Promise<ContainerHealthResponse> {
    return this.request<ContainerHealthResponse>(
      "GET",
      `/api/v1/containers/${encodePathParam(containerId)}/health`,
    );
  }

  getContainerMetrics(containerId: string): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      `/api/v1/containers/${encodePathParam(containerId)}/metrics`,
    );
  }

  async getContainerLogs(containerId: string, tail?: number): Promise<string> {
    const response = await this.requestRaw(
      "GET",
      `/api/v1/containers/${encodePathParam(containerId)}/logs`,
      {
        query: tail === undefined ? undefined : { tail },
        headers: { Accept: "text/plain" },
      },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new CloudApiError(response.status, {
        success: false,
        error:
          text.trim().length > 0
            ? `HTTP ${response.status}: ${text}`
            : `HTTP ${response.status}: ${response.statusText}`,
      });
    }
    return text;
  }

  getContainerDeployments(
    containerId: string,
  ): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      `/api/v1/containers/${encodePathParam(containerId)}/deployments`,
    );
  }

  getContainerQuota(): Promise<ContainerQuotaResponse> {
    return this.request<ContainerQuotaResponse>(
      "GET",
      "/api/v1/containers/quota",
    );
  }

  createContainerCredentials(
    request: Record<string, unknown> = {},
  ): Promise<ContainerCredentialsResponse> {
    return this.request<ContainerCredentialsResponse>(
      "POST",
      "/api/v1/containers/credentials",
      {
        json: request,
      },
    );
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
    return this.request<AgentResponse>(
      "GET",
      `/api/v1/eliza/agents/${encodePathParam(agentId)}`,
    );
  }

  updateAgent(
    agentId: string,
    request: Partial<CreateAgentRequest>,
  ): Promise<AgentResponse> {
    return this.request<AgentResponse>(
      "PATCH",
      `/api/v1/eliza/agents/${encodePathParam(agentId)}`,
      { json: request },
    );
  }

  deleteAgent(agentId: string): Promise<AgentLifecycleResponse> {
    return this.request(
      "DELETE",
      `/api/v1/eliza/agents/${encodePathParam(agentId)}`,
    );
  }

  provisionAgent(agentId: string): Promise<AgentLifecycleResponse> {
    return this.request(
      "POST",
      `/api/v1/eliza/agents/${encodePathParam(agentId)}/provision`,
    );
  }

  suspendAgent(agentId: string): Promise<AgentLifecycleResponse> {
    return this.request(
      "POST",
      `/api/v1/eliza/agents/${encodePathParam(agentId)}/suspend`,
    );
  }

  resumeAgent(agentId: string): Promise<AgentLifecycleResponse> {
    return this.request(
      "POST",
      `/api/v1/eliza/agents/${encodePathParam(agentId)}/resume`,
    );
  }

  createAgentSnapshot(
    agentId: string,
    snapshotType: SnapshotType = "manual",
    metadata?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `/api/v1/eliza/agents/${encodePathParam(agentId)}/snapshot`,
      {
        json: { snapshotType, metadata },
      },
    );
  }

  listAgentBackups(agentId: string): Promise<SnapshotListResponse> {
    return this.request(
      "GET",
      `/api/v1/eliza/agents/${encodePathParam(agentId)}/backups`,
    );
  }

  restoreAgentBackup(
    agentId: string,
    backupId?: string,
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `/api/v1/eliza/agents/${encodePathParam(agentId)}/restore`,
      {
        json: backupId ? { backupId } : {},
      },
    );
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
    return this.v1.post(
      `/eliza/gateway-relay/sessions/${encodePathParam(sessionId)}/responses`,
      {
        requestId,
        response,
      },
    );
  }

  disconnectGatewayRelaySession(
    sessionId: string,
  ): Promise<{ success: boolean }> {
    return this.v1.delete(
      `/eliza/gateway-relay/sessions/${encodePathParam(sessionId)}`,
    );
  }

  getJob(jobId: string): Promise<JobStatus> {
    return this.request("GET", `/api/v1/jobs/${encodePathParam(jobId)}`);
  }

  async pollJob(
    jobId: string,
    options: { timeoutMs?: number; intervalMs?: number } = {},
  ) {
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
    return this.request(
      "PATCH",
      `/api/v1/api-keys/${encodePathParam(apiKeyId)}`,
      {
        json: request,
      },
    );
  }

  deleteApiKey(
    apiKeyId: string,
  ): Promise<{ success?: boolean; message?: string }> {
    return this.request(
      "DELETE",
      `/api/v1/api-keys/${encodePathParam(apiKeyId)}`,
    );
  }

  regenerateApiKey(apiKeyId: string): Promise<ApiKeyCreateResponse> {
    return this.request(
      "POST",
      `/api/v1/api-keys/${encodePathParam(apiKeyId)}/regenerate`,
    );
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

  createWorkflow(
    agentId: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request(
      "POST",
      `/api/v1/agents/${encodePathParam(agentId)}/workflows`,
      {
        json: body,
      },
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

export function createElizaCloudClient(
  options?: ElizaCloudClientOptions,
): ElizaCloudClient {
  return new ElizaCloudClient(options);
}
