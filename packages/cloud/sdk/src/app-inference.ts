/** Sends app-customer model requests with separate confidential app delegation and developer infrastructure credentials. */
import { CloudApiClient } from "./http.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  CloudRequestOptions,
} from "./types.js";

export interface AppInferenceClientOptions {
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  clientId: string;
  clientSecret: string;
  /** App-scoped developer Cloud API key. This is never the customer's personal credential. */
  developerApiKey: string;
}
export interface AppInferenceOperation {
  billingAccountId: string;
  productFamilyKey: string;
  delegationToken: string;
  /** Persist before dispatch and reuse for the exact same operation after transport failure. */
  operationId: string;
}
export type AppInferenceRequestOptions = Pick<
  CloudRequestOptions,
  "signal" | "timeoutMs"
>;

/** Keep this client and all its credentials in the application's server process. */
export class AppInferenceClient {
  private readonly http: CloudApiClient;
  constructor(
    readonly appId: string,
    private readonly options: AppInferenceClientOptions,
  ) {
    this.http = new CloudApiClient(options.apiBaseUrl, undefined, {
      fetchImpl: options.fetchImpl,
    });
  }
  private requestOptions(
    operation: AppInferenceOperation,
    options: AppInferenceRequestOptions,
  ): CloudRequestOptions {
    return {
      ...options,
      headers: {
        Authorization: `Basic ${btoa(`${this.options.clientId}:${this.options.clientSecret}`)}`,
        "X-App-Delegation": operation.delegationToken,
        "X-Eliza-Developer-Authorization": `Bearer ${this.options.developerApiKey}`,
        "X-Eliza-Billing-Account-Id": operation.billingAccountId,
        "X-Eliza-Product-Family": operation.productFamilyKey,
        "Idempotency-Key": operation.operationId,
      },
    };
  }
  createChatCompletion(
    operation: AppInferenceOperation,
    request: Omit<ChatCompletionRequest, "stream"> & { stream?: false },
    options: AppInferenceRequestOptions = {},
  ): Promise<ChatCompletionResponse> {
    return this.http.requestData(
      "POST",
      `/apps/${encodeURIComponent(this.appId)}/inference/chat/completions`,
      { ...this.requestOptions(operation, options), json: request },
    );
  }
  /** Returns the original HTTP/SSE response; inspect status before consuming the stream. */
  streamChatCompletion(
    operation: AppInferenceOperation,
    request: Omit<ChatCompletionRequest, "stream">,
    options: AppInferenceRequestOptions = {},
  ): Promise<Response> {
    return this.http.requestRaw(
      "POST",
      `/apps/${encodeURIComponent(this.appId)}/inference/chat/completions`,
      {
        ...this.requestOptions(operation, options),
        json: { ...request, stream: true },
      },
    );
  }
}
