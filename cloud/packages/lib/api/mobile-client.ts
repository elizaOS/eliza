/**
 * Mobile API Client
 *
 * Provides an API client that works in both web and mobile contexts.
 * In mobile builds, all API calls are routed to Eliza Cloud.
 * In web builds, calls go to the current origin.
 */

/**
 * Check if running in a mobile app
 */
export function isMobileApp(): boolean {
  if (typeof window === "undefined") return false;

  return process.env.NEXT_PUBLIC_IS_MOBILE_APP === "true";
}

/**
 * Check if running on iOS
 */
export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

/**
 * Check if running on Android
 */
export function isAndroid(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android/.test(navigator.userAgent);
}

/**
 * Get the appropriate API base URL
 * - Mobile: Always use the Eliza Cloud production API
 * - Web: Use current origin for same-origin requests
 * - SSR: Use environment variable or localhost
 */
export function getApiBaseUrl(): string {
  // Mobile always uses production API
  if (isMobileApp()) {
    return process.env.NEXT_PUBLIC_API_URL || "https://www.elizacloud.ai";
  }

  // Server-side rendering
  if (typeof window === "undefined") {
    return process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";
  }

  // Web client uses same origin
  return window.location.origin;
}

/**
 * API response type
 */
interface ApiResponse<T> {
  data: T;
  status: number;
  ok: boolean;
}

/**
 * API error type
 */
export class ApiError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code || `HTTP_${status}`;
  }
}

/**
 * Request options extending standard RequestInit
 */
interface ApiRequestOptions extends Omit<RequestInit, "body"> {
  body?: Record<string, unknown> | FormData;
  params?: Record<string, string | number | boolean | undefined>;
  token?: string;
}

/**
 * Mobile API client singleton
 */
class MobileApiClient {
  private baseUrl: string;
  private defaultHeaders: Record<string, string>;

  constructor() {
    this.baseUrl = getApiBaseUrl();
    this.defaultHeaders = {
      "Content-Type": "application/json",
    };
  }

  /**
   * Update the base URL (useful when switching environments)
   */
  setBaseUrl(url: string): void {
    this.baseUrl = url;
  }

  /**
   * Build URL with query parameters
   */
  private buildUrl(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): string {
    const url = new URL(path, this.baseUrl);

    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      });
    }

    return url.toString();
  }

  /**
   * Make an API request
   */
  async request<T>(
    method: string,
    path: string,
    options: ApiRequestOptions = {},
  ): Promise<ApiResponse<T>> {
    const { body, params, token, ...fetchOptions } = options;

    const url = this.buildUrl(path, params);

    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      ...(fetchOptions.headers as Record<string, string>),
    };

    // Add authorization token if provided
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    // Handle body
    let requestBody: string | FormData | undefined;
    if (body instanceof FormData) {
      requestBody = body;
      delete headers["Content-Type"]; // Let browser set multipart boundary
    } else if (body) {
      requestBody = JSON.stringify(body);
    }

    const response = await fetch(url, {
      method,
      headers,
      body: requestBody,
      credentials: "include",
      ...fetchOptions,
    });

    // Handle non-JSON responses
    const contentType = response.headers.get("content-type");
    let data: T;

    if (contentType?.includes("application/json")) {
      data = await response.json();
    } else {
      data = (await response.text()) as T;
    }

    if (!response.ok) {
      const errorMessage =
        (data as { error?: string; message?: string })?.error ||
        (data as { error?: string; message?: string })?.message ||
        `Request failed with status ${response.status}`;
      throw new ApiError(errorMessage, response.status);
    }

    return {
      data,
      status: response.status,
      ok: response.ok,
    };
  }

  /**
   * GET request
   */
  async get<T>(path: string, options?: ApiRequestOptions): Promise<T> {
    const response = await this.request<T>("GET", path, options);
    return response.data;
  }

  /**
   * POST request
   */
  async post<T>(
    path: string,
    body?: Record<string, unknown>,
    options?: ApiRequestOptions,
  ): Promise<T> {
    const response = await this.request<T>("POST", path, { ...options, body });
    return response.data;
  }

  /**
   * PUT request
   */
  async put<T>(
    path: string,
    body?: Record<string, unknown>,
    options?: ApiRequestOptions,
  ): Promise<T> {
    const response = await this.request<T>("PUT", path, { ...options, body });
    return response.data;
  }

  /**
   * PATCH request
   */
  async patch<T>(
    path: string,
    body?: Record<string, unknown>,
    options?: ApiRequestOptions,
  ): Promise<T> {
    const response = await this.request<T>("PATCH", path, { ...options, body });
    return response.data;
  }

  /**
   * DELETE request
   */
  async delete<T>(path: string, options?: ApiRequestOptions): Promise<T> {
    const response = await this.request<T>("DELETE", path, options);
    return response.data;
  }
}

/**
 * Singleton API client instance
 */
export const api = new MobileApiClient();

/**
 * Create an authenticated API client with a token
 */
export function createAuthenticatedClient(token: string) {
  return {
    get: <T>(path: string, options?: Omit<ApiRequestOptions, "token">) =>
      api.get<T>(path, { ...options, token }),
    post: <T>(
      path: string,
      body?: Record<string, unknown>,
      options?: Omit<ApiRequestOptions, "token">,
    ) => api.post<T>(path, body, { ...options, token }),
    put: <T>(
      path: string,
      body?: Record<string, unknown>,
      options?: Omit<ApiRequestOptions, "token">,
    ) => api.put<T>(path, body, { ...options, token }),
    patch: <T>(
      path: string,
      body?: Record<string, unknown>,
      options?: Omit<ApiRequestOptions, "token">,
    ) => api.patch<T>(path, body, { ...options, token }),
    delete: <T>(path: string, options?: Omit<ApiRequestOptions, "token">) =>
      api.delete<T>(path, { ...options, token }),
  };
}

/**
 * API endpoints for convenience
 */
export const endpoints = {
  // Auth
  auth: {
    session: "/api/auth/session",
    migrate: "/api/auth/migrate-anonymous",
  },

  // Credits
  credits: {
    balance: "/api/credits/balance",
    topup: "/api/v1/credits/topup",
  },

  // Dashboard
  dashboard: {
    data: "/api/v1/dashboard",
    agents: "/api/v1/agents",
    containers: "/api/v1/containers",
  },

  // Billing
  billing: {
    creditPacks: "/api/stripe/credit-packs",
    checkout: "/api/stripe/create-checkout-session",
  },

  // Chat
  chat: {
    send: "/api/eliza/rooms",
    history: (roomId: string) => `/api/eliza/rooms/${roomId}/messages`,
  },

  // Characters
  characters: {
    list: "/api/my-agents/characters",
    get: (id: string) => `/api/my-agents/characters/${id}`,
  },

  // API Keys
  apiKeys: {
    list: "/api/v1/api-keys",
    create: "/api/v1/api-keys",
    revoke: (id: string) => `/api/v1/api-keys/${id}`,
  },
} as const;
