/** Public contracts for app-scoped identity and explicitly consented connector delegation. */
export const APP_DELEGATION_SCOPES = [
  "identity",
  "google.basic_identity",
  "google.gmail.triage",
  "google.gmail.send",
  "google.calendar.read",
  "google.calendar.write",
  "billing:read",
  "billing:write",
  "inference",
] as const;
export type AppDelegationScope = (typeof APP_DELEGATION_SCOPES)[number];

export interface AppDelegationBinding {
  clientId: string;
  redirectUri: string;
  scopes: AppDelegationScope[];
}

export interface AppDelegationPrincipal {
  id: string;
  organizationId: string | null;
  email: string | null;
  name: string | null;
  emailVerified: boolean;
}

export interface AppDelegationResult {
  billingEnvironment: "test" | "live";
  token: string;
  expiresAt: string;
  appId: string;
  scopes: AppDelegationScope[];
  user: AppDelegationPrincipal;
}

/** Human-readable consent terms; connector access never follows from identity alone. */
export const APP_DELEGATION_SCOPE_LABELS: Readonly<
  Record<AppDelegationScope, string>
> = {
  identity: "Read your account identity",
  "google.basic_identity": "Read the identity of your connected Google account",
  "google.gmail.triage":
    "Read and search mail in your connected Google account",
  "google.gmail.send": "Send mail from your connected Google account",
  "google.calendar.read": "Read your connected Google calendars",
  "google.calendar.write":
    "Create, edit, and delete events in your connected Google calendars",
  "billing:read": "Read your subscriptions and invoices for this app",
  "billing:write": "Manage your subscriptions for this app",
  inference: "Use this app’s AI features with your app allowance",
};

import { CloudApiClient } from "./http.js";
import type { ElizaCloudClientOptions } from "./types.js";

export interface AppGoogleConnection {
  connectionId: string | null;
  connected: boolean;
  identity: Record<string, unknown> | null;
  grantedCapabilities: AppDelegationScope[];
  reason: string;
}

/** Server-side client: keep the confidential client secret and opaque user grants outside browser storage. */
export class AppDelegationClient {
  readonly http: CloudApiClient;
  private readonly authorization: string;
  constructor(options: {
    clientId: string;
    clientSecret: string;
    apiBaseUrl?: string;
    fetchImpl?: ElizaCloudClientOptions["fetchImpl"];
  }) {
    this.authorization = `Basic ${btoa(`${options.clientId}:${options.clientSecret}`)}`;
    this.http = new CloudApiClient(options.apiBaseUrl, undefined, {
      fetchImpl: options.fetchImpl,
      defaultHeaders: { Authorization: this.authorization },
    });
  }
  exchange(code: string, redirectUri: string) {
    return this.http.post<{ success: true; data: AppDelegationResult }>(
      "/app-auth/delegations/token",
      { code, redirectUri },
    );
  }
  identity(token: string) {
    return this.http.get<{ success: true; data: AppDelegationPrincipal }>(
      "/app-auth/delegations/identity",
      { headers: this.headers(token) },
    );
  }
  revoke(token: string) {
    return this.http.post<{ success: true }>(
      "/app-auth/delegations/revoke",
      undefined,
      { headers: this.headers(token) },
    );
  }
  googleConnections(token: string) {
    return this.http.get<{ success: true; data: AppGoogleConnection[] }>(
      "/app-auth/delegations/google/connections",
      { headers: this.headers(token) },
    );
  }
  connectGoogle(
    token: string,
    input: {
      redirectUri: string;
      capabilities: Extract<AppDelegationScope, `google.${string}`>[];
    },
  ) {
    return this.http.post<{
      success: true;
      data: {
        authUrl: string;
        redirectUri: string;
        requestedCapabilities: AppDelegationScope[];
      };
    }>("/app-auth/delegations/google/connect", input, {
      headers: this.headers(token),
    });
  }
  googleRequest(
    token: string,
    input: {
      connectionId: string;
      method: "GET" | "POST" | "PATCH" | "DELETE";
      url: string;
      body?: string;
    },
  ) {
    return this.http.requestRaw(
      "POST",
      "/app-auth/delegations/google/request",
      { json: input, headers: this.headers(token) },
    );
  }
  /** Use with the Cloud SDK billing client; app-account membership is checked independently by Cloud. */
  headers(token: string): Headers {
    const headers = new Headers({ Authorization: this.authorization });
    headers.set("X-App-Delegation", token);
    return headers;
  }
}

/** Safe registration metadata; hashed and clear client secrets are never returned by list reads. */
export interface AppDelegationRegistration {
  billingReturnUrl: string | null;
  clientId: string;
  billingEnvironment: "test" | "live";
  redirectUris: string[];
  allowedScopes: AppDelegationScope[];
  revision: number;
  active: boolean;
  createdAt: string;
}
export interface RegisterAppDelegationClientRequest {
  /** Exact HTTPS destination on an allowed app origin; null keeps the Cloud billing page. */
  billingReturnUrl?: string | null;
  billingEnvironment: "test" | "live";
  redirectUris: string[];
  allowedScopes: AppDelegationScope[];
}
export interface AppDelegationClientSecret {
  clientId: string;
  clientSecret: string;
  revision: number;
  billingEnvironment: "test" | "live";
}
/** Current app-owner administrators manage confidential clients through their free Cloud session. */
export class AppDelegationManagementClient {
  private readonly path: string;
  constructor(
    private readonly api: CloudApiClient,
    appId: string,
  ) {
    this.path = `/apps/${encodeURIComponent(appId)}/delegation-clients`;
  }
  list() {
    return this.api.get<{ success: true; data: AppDelegationRegistration[] }>(
      this.path,
    );
  }
  register(input: RegisterAppDelegationClientRequest) {
    return this.api.post<{ success: true; data: AppDelegationClientSecret }>(
      this.path,
      input,
    );
  }
  rotate(clientId: string) {
    return this.api.post<{ success: true; data: AppDelegationClientSecret }>(
      `${this.path}/${encodeURIComponent(clientId)}/rotate`,
      {},
    );
  }
  revoke(clientId: string) {
    return this.api.delete<{ success: true }>(
      `${this.path}/${encodeURIComponent(clientId)}`,
    );
  }
}
