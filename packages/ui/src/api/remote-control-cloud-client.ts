/**
 * Typed owner-side client for secure remote hosts, pairing sessions, and opaque
 * command relay envelopes. It validates every untrusted Cloud response before
 * exposing it to Settings or the agent transport.
 */
import type {
  EncryptedRemoteControlEnvelope,
  RemoteControllerPlatform,
  RemoteControllerPublicIdentity,
} from "@elizaos/shared/contracts/remote-control";
import { desktopHttpTransportForUrl } from "./desktop-http-transport";
import { resolveDirectCloudAuthApiBase } from "./direct-cloud-endpoints";
import { fetchAgentTransport } from "./transport";

export interface RemoteHostSummary {
  id: string;
  deviceId: string;
  displayName: string;
  platform: RemoteControllerPlatform;
  connectionMode: string;
  runtimeKeyId: string;
  signingPublicKeyJwk: JsonWebKey;
  encryptionPublicKeyJwk: JsonWebKey;
  status: "active" | "offline" | "revoked" | string;
  lastSeenAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface RemoteHostDirectory {
  ownerId: string;
  hosts: RemoteHostSummary[];
}

export interface RemoteSessionSummary {
  id: string;
  ownerId: string;
  grantId: string;
  grantRevision: number;
  hostId: string;
  targetRuntimeId: string;
  status: string;
  controllerDeviceId: string;
  controllerKeyId: string;
  targetKeyId: string;
  grantExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RemotePairingReceipt {
  ownerId: string;
  sessionId: string;
  grantId: string;
  grantRevision: number;
  targetRuntimeId: string;
  targetKeyId: string;
  code: string;
  expiresAt: string;
  grantExpiresAt: string;
  ttlSeconds: number;
  status: string;
}

export type RemoteRelayCommandStatus =
  | "pending"
  | "claimed"
  | "started"
  | "completed"
  | "failed"
  | "expired"
  | "cancelled"
  | "execution_ambiguous";

export class RemoteCloudRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "RemoteCloudRequestError";
  }
}

interface RemoteControlCloudClientOptions {
  baseUrl: string;
  authToken: string;
  request?: (url: string, init: RequestInit) => Promise<Response>;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Cloud response is missing ${field}.`);
  }
  return value;
}

function requiredInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Cloud response is missing ${field}.`);
  }
  return value as number;
}

function publicJwk(value: unknown, field: string): JsonWebKey {
  const key = record(value);
  if (
    key?.kty !== "EC" ||
    key.crv !== "P-256" ||
    typeof key.x !== "string" ||
    typeof key.y !== "string" ||
    key.d !== undefined
  ) {
    throw new Error(`Cloud response has an invalid ${field}.`);
  }
  return key as JsonWebKey;
}

function parseHost(value: unknown): RemoteHostSummary {
  const item = record(value);
  if (!item) throw new Error("Cloud response contains an invalid remote host.");
  const platform = requiredString(item.platform, "host platform");
  if (
    !["macos", "windows", "linux", "ios", "android", "web"].includes(platform)
  ) {
    throw new Error("Cloud response contains an invalid host platform.");
  }
  return {
    id: requiredString(item.id, "host id"),
    deviceId: requiredString(item.deviceId, "host device id"),
    displayName: requiredString(item.displayName, "host name"),
    platform: platform as RemoteControllerPlatform,
    connectionMode: requiredString(item.connectionMode, "connection mode"),
    runtimeKeyId: requiredString(item.runtimeKeyId, "runtime key id"),
    signingPublicKeyJwk: publicJwk(item.signingPublicKeyJwk, "signing key"),
    encryptionPublicKeyJwk: publicJwk(
      item.encryptionPublicKeyJwk,
      "encryption key",
    ),
    status: requiredString(item.status, "host status"),
    lastSeenAt: typeof item.lastSeenAt === "string" ? item.lastSeenAt : null,
    createdAt: requiredString(item.createdAt, "host creation time"),
    revokedAt: typeof item.revokedAt === "string" ? item.revokedAt : null,
  };
}

function parseSession(value: unknown): RemoteSessionSummary {
  const item = record(value);
  if (!item) {
    throw new Error("Cloud response contains an invalid remote session.");
  }
  return {
    id: requiredString(item.id, "session id"),
    ownerId: requiredString(item.ownerId, "session owner id"),
    grantId: requiredString(item.grantId, "grant id"),
    grantRevision: requiredInteger(item.grantRevision, "grant revision"),
    hostId: requiredString(item.hostId, "host id"),
    targetRuntimeId: requiredString(
      item.targetRuntimeId ?? item.hostId,
      "target runtime id",
    ),
    status: requiredString(item.status, "session status"),
    controllerDeviceId: requiredString(
      item.controllerDeviceId,
      "controller device id",
    ),
    controllerKeyId: requiredString(item.controllerKeyId, "controller key id"),
    targetKeyId: requiredString(item.targetKeyId, "target key id"),
    grantExpiresAt:
      typeof item.grantExpiresAt === "string" ? item.grantExpiresAt : null,
    createdAt: requiredString(item.createdAt, "session creation time"),
    updatedAt: requiredString(item.updatedAt, "session update time"),
  };
}

export class RemoteControlCloudClient {
  private readonly baseUrl: string;
  private readonly authToken: string;
  private readonly requestImpl: (
    url: string,
    init: RequestInit,
  ) => Promise<Response>;

  constructor(options: RemoteControlCloudClientOptions) {
    this.baseUrl = resolveDirectCloudAuthApiBase(options.baseUrl).replace(
      /\/+$/,
      "",
    );
    this.authToken = options.authToken.trim();
    if (!this.authToken)
      throw new Error("Sign in to Eliza Cloud to manage devices.");
    this.requestImpl =
      options.request ??
      (async (url, init) => {
        const transport =
          desktopHttpTransportForUrl(url) ?? fetchAgentTransport;
        return transport.request(url, init, { timeoutMs: 30_000 });
      });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.requestImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.authToken}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    let payload: unknown = null;
    if (response.status !== 204) {
      try {
        payload = await response.json();
      } catch {
        // error-policy:J1 invalid Cloud response translates to a stable client error.
        throw new RemoteCloudRequestError(
          "Eliza Cloud returned an unreadable response. Try again.",
          response.status,
        );
      }
    }
    const envelope = record(payload);
    if (!response.ok || envelope?.success === false) {
      throw new RemoteCloudRequestError(
        typeof envelope?.error === "string"
          ? envelope.error
          : "The remote device request failed. Try again.",
        response.status,
        typeof envelope?.code === "string" ? envelope.code : undefined,
      );
    }
    return (record(envelope?.data) ?? payload) as T;
  }

  async listHosts(): Promise<RemoteHostDirectory> {
    const data = await this.request<{ ownerId?: unknown; hosts?: unknown }>(
      "/api/v1/remote/hosts",
    );
    if (!Array.isArray(data.hosts)) {
      throw new Error("Cloud response is missing remote hosts.");
    }
    return {
      ownerId: requiredString(data.ownerId, "owner id"),
      hosts: data.hosts.map(parseHost),
    };
  }

  async listSessions(hostId: string): Promise<RemoteSessionSummary[]> {
    const data = await this.request<{ sessions?: unknown }>(
      `/api/v1/remote/sessions?hostId=${encodeURIComponent(hostId)}`,
    );
    if (!Array.isArray(data.sessions)) {
      throw new Error("Cloud response is missing remote sessions.");
    }
    return data.sessions.map(parseSession);
  }

  async createPairing(input: {
    hostId: string;
    controller: RemoteControllerPublicIdentity;
    grantTtlSeconds?: number;
  }): Promise<RemotePairingReceipt> {
    const data = await this.request<Record<string, unknown>>(
      "/api/v1/remote/pair",
      {
        method: "POST",
        cache: "no-store",
        body: JSON.stringify({
          hostId: input.hostId,
          controller: input.controller,
          ...(input.grantTtlSeconds
            ? { grantTtlSeconds: input.grantTtlSeconds }
            : {}),
        }),
      },
    );
    const code = requiredString(data.code, "pairing code");
    if (!/^\d{6}$/.test(code)) {
      throw new Error("Cloud response contains an invalid pairing code.");
    }
    return {
      ownerId: requiredString(data.ownerId, "owner id"),
      sessionId: requiredString(data.sessionId, "session id"),
      grantId: requiredString(data.grantId, "grant id"),
      grantRevision: requiredInteger(data.grantRevision, "grant revision"),
      targetRuntimeId: requiredString(
        data.targetRuntimeId,
        "target runtime id",
      ),
      targetKeyId: requiredString(data.targetKeyId, "target key id"),
      code,
      expiresAt: requiredString(data.expiresAt, "pairing expiration"),
      grantExpiresAt: requiredString(data.grantExpiresAt, "grant expiration"),
      ttlSeconds:
        Number.isSafeInteger(data.ttlSeconds) && Number(data.ttlSeconds) > 0
          ? Number(data.ttlSeconds)
          : Math.max(
              0,
              Math.ceil(
                (Date.parse(
                  requiredString(data.expiresAt, "pairing expiration"),
                ) -
                  Date.now()) /
                  1_000,
              ),
            ),
      status: requiredString(data.status, "pairing status"),
    };
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.request(
      `/api/v1/remote/sessions/${encodeURIComponent(sessionId)}/revoke`,
      {
        method: "POST",
      },
    );
  }

  async revokeHost(hostId: string): Promise<void> {
    await this.request(
      `/api/v1/remote/hosts/${encodeURIComponent(hostId)}/revoke`,
      {
        method: "POST",
      },
    );
  }

  async enqueueCommand(input: {
    sessionId: string;
    envelope: EncryptedRemoteControlEnvelope;
  }): Promise<void> {
    await this.request(
      `/api/v1/remote/sessions/${encodeURIComponent(input.sessionId)}/commands`,
      { method: "POST", body: JSON.stringify({ envelope: input.envelope }) },
    );
  }

  async readCommand(input: { sessionId: string; commandId: string }): Promise<{
    status: RemoteRelayCommandStatus;
    startReceipt: EncryptedRemoteControlEnvelope | null;
    resultEnvelope: EncryptedRemoteControlEnvelope | null;
  }> {
    const data = await this.request<Record<string, unknown>>(
      `/api/v1/remote/sessions/${encodeURIComponent(input.sessionId)}/commands/${encodeURIComponent(input.commandId)}`,
    );
    const status = requiredString(data.status, "command status");
    if (
      ![
        "pending",
        "claimed",
        "started",
        "completed",
        "failed",
        "expired",
        "cancelled",
        "execution_ambiguous",
      ].includes(status)
    ) {
      throw new Error("Cloud response contains an invalid command status.");
    }
    return {
      status: status as RemoteRelayCommandStatus,
      startReceipt: record(
        data.startReceipt,
      ) as EncryptedRemoteControlEnvelope | null,
      resultEnvelope: record(
        data.resultEnvelope,
      ) as EncryptedRemoteControlEnvelope | null,
    };
  }
}
