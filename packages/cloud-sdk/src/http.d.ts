import {
  type CloudApiErrorBody,
  type CloudRequestOptions,
  type ElizaCloudClientOptions,
  type HttpMethod,
  type QueryParams,
} from "./types.js";
export declare class CloudApiError extends Error {
  readonly statusCode: number;
  readonly errorBody: CloudApiErrorBody;
  constructor(statusCode: number, body: CloudApiErrorBody);
}
export declare class InsufficientCreditsError extends CloudApiError {
  readonly requiredCredits: number;
  constructor(body: CloudApiErrorBody);
}
export declare class ElizaCloudHttpClient {
  private baseUrl;
  private apiKey;
  private bearerToken;
  private readonly fetchImpl;
  private readonly defaultHeaders;
  constructor(options?: ElizaCloudClientOptions);
  setApiKey(key: string | undefined): void;
  setBearerToken(token: string | undefined): void;
  setBaseUrl(url: string): void;
  getBaseUrl(): string;
  getApiKey(): string | undefined;
  buildWsUrl(path: string): string;
  buildUrl(path: string, query?: QueryParams): string;
  requestRaw(
    method: HttpMethod,
    path: string,
    options?: CloudRequestOptions,
  ): Promise<Response>;
  request<TResponse>(
    method: HttpMethod,
    path: string,
    options?: CloudRequestOptions,
  ): Promise<TResponse>;
  get<TResponse>(
    path: string,
    options?: CloudRequestOptions,
  ): Promise<TResponse>;
  post<TResponse>(
    path: string,
    body?: unknown,
    options?: Omit<CloudRequestOptions, "json">,
  ): Promise<TResponse>;
  put<TResponse>(
    path: string,
    body?: unknown,
    options?: Omit<CloudRequestOptions, "json">,
  ): Promise<TResponse>;
  patch<TResponse>(
    path: string,
    body?: unknown,
    options?: Omit<CloudRequestOptions, "json">,
  ): Promise<TResponse>;
  delete<TResponse>(
    path: string,
    options?: CloudRequestOptions,
  ): Promise<TResponse>;
}
export declare class CloudApiClient extends ElizaCloudHttpClient {
  constructor(
    baseUrl?: string,
    apiKey?: string,
    options?: Omit<
      ElizaCloudClientOptions,
      "apiBaseUrl" | "apiKey" | "baseUrl"
    >,
  );
  postUnauthenticated<TResponse>(
    path: string,
    body: unknown,
  ): Promise<TResponse>;
}
//# sourceMappingURL=http.d.ts.map
