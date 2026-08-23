/**
 * Typed owner-side client for secure remote hosts, pairing sessions, and opaque
 * command relay envelopes. It validates every untrusted Cloud response before
 * exposing it to Settings or the agent transport.
 */
import { ElizaError } from "@elizaos/core";
import type {
  EncryptedRemoteControlEnvelope,
  RemoteControllerPlatform,
  RemoteControllerPublicIdentity,
} from "@elizaos/shared/contracts/remote-control";
import {
  isEncryptedRemoteControlEnvelope,
  isRemoteControlIdentifier,
} from "@elizaos/shared/contracts/remote-control";
import { desktopHttpTransportForUrl } from "./desktop-http-transport";
import { resolveDirectCloudAuthApiBase } from "./direct-cloud-endpoints";
import { fetchAgentTransport } from "./transport";

export interface RemoteHostSummary {
  id: string;
  deviceId: string;
  displayName: string;
  platform: RemoteControllerPlatform;
  connectionMode: "relay";
  runtimeKeyId: string;
  signingPublicKeyJwk: JsonWebKey;
  encryptionPublicKeyJwk: JsonWebKey;
  status: "pending" | "active" | "offline" | "revoked";
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
  status: "pending" | "active" | "denied" | "revoked" | "expired";
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
  status: "pending";
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

export class RemoteControlAuthenticationRequiredError extends Error {
  constructor() {
    super("Sign in to Eliza Cloud to manage devices.");
    this.name = "RemoteControlAuthenticationRequiredError";
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
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`Cloud response is missing ${field}.`);
  }
  return value as number;
}

function identifier(value: unknown, field: string): string {
  if (!isRemoteControlIdentifier(value)) {
    throw new Error(`Cloud response has an invalid ${field}.`);
  }
  return value;
}

function uuid(value: unknown, field: string): string {
  const result = identifier(value, field);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      result,
    )
  ) {
    throw new Error(`Cloud response has an invalid ${field}.`);
  }
  return result;
}

function exactEnum<const T extends string>(
  value: unknown,
  field: string,
  values: readonly T[],
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`Cloud response has an invalid ${field}.`);
  }
  return value as T;
}

function isoDate(value: unknown, field: string): string {
  const result = requiredString(value, field);
  const timestamp = Date.parse(result);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== result
  ) {
    throw new Error(`Cloud response has an invalid ${field}.`);
  }
  return result;
}

function optionalIsoDate(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : isoDate(value, field);
}

function publicJwk(value: unknown, field: string): JsonWebKey {
  const key = record(value);
  if (
    key?.kty !== "EC" ||
    key.crv !== "P-256" ||
    typeof key.x !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(key.x) ||
    typeof key.y !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(key.y) ||
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
    id: uuid(item.id, "host id"),
    deviceId: identifier(item.deviceId, "host device id"),
    displayName: requiredString(item.displayName, "host name"),
    platform: platform as RemoteControllerPlatform,
    connectionMode: exactEnum(item.connectionMode, "connection mode", [
      "relay",
    ]),
    runtimeKeyId: identifier(item.runtimeKeyId, "runtime key id"),
    signingPublicKeyJwk: publicJwk(item.signingPublicKeyJwk, "signing key"),
    encryptionPublicKeyJwk: publicJwk(
      item.encryptionPublicKeyJwk,
      "encryption key",
    ),
    status: exactEnum(item.status, "host status", [
      "pending",
      "active",
      "offline",
      "revoked",
    ]),
    lastSeenAt: optionalIsoDate(item.lastSeenAt, "host last-seen time"),
    createdAt: isoDate(item.createdAt, "host creation time"),
    revokedAt: optionalIsoDate(item.revokedAt, "host revocation time"),
  };
}

function parseSession(
  value: unknown,
  expectedHostId: string,
  expectedOwnerId?: string,
): RemoteSessionSummary {
  const item = record(value);
  if (!item) {
    throw new Error("Cloud response contains an invalid remote session.");
  }
  const hostId = uuid(item.hostId, "host id");
  const targetRuntimeId = uuid(
    item.targetRuntimeId ?? item.hostId,
    "target runtime id",
  );
  if (hostId !== expectedHostId || targetRuntimeId !== expectedHostId) {
    throw new Error("Cloud response contains a session for a different host.");
  }
  const ownerId = uuid(item.ownerId, "session owner id");
  if (expectedOwnerId && ownerId !== expectedOwnerId) {
    throw new Error("Cloud response contains a session for a different owner.");
  }
  return {
    id: uuid(item.id, "session id"),
    ownerId,
    grantId: uuid(item.grantId, "grant id"),
    grantRevision: requiredInteger(item.grantRevision, "grant revision"),
    hostId,
    targetRuntimeId,
    status: exactEnum(item.status, "session status", [
      "pending",
      "active",
      "denied",
      "revoked",
      "expired",
    ]),
    controllerDeviceId: identifier(
      item.controllerDeviceId,
      "controller device id",
    ),
    controllerKeyId: identifier(item.controllerKeyId, "controller key id"),
    targetKeyId: identifier(item.targetKeyId, "target key id"),
    grantExpiresAt: optionalIsoDate(item.grantExpiresAt, "grant expiration"),
    createdAt: isoDate(item.createdAt, "session creation time"),
    updatedAt: isoDate(item.updatedAt, "session update time"),
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
    if (!this.authToken) throw new RemoteControlAuthenticationRequiredError();
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
      const cloudMessage =
        typeof envelope?.error === "string" &&
        envelope.error.length <= 256 &&
        !/[\r\n]/.test(envelope.error)
          ? envelope.error
          : "The remote device request failed. Try again.";
      throw new RemoteCloudRequestError(
        cloudMessage,
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
      ownerId: uuid(data.ownerId, "owner id"),
      hosts: data.hosts.map(parseHost),
    };
  }

  async listSessions(
    hostId: string,
    ownerId?: string,
  ): Promise<RemoteSessionSummary[]> {
    const expectedHostId = uuid(hostId, "host id");
    const expectedOwnerId = ownerId ? uuid(ownerId, "owner id") : undefined;
    const data = await this.request<{ sessions?: unknown }>(
      `/api/v1/remote/sessions?hostId=${encodeURIComponent(hostId)}`,
    );
    if (!Array.isArray(data.sessions)) {
      throw new Error("Cloud response is missing remote sessions.");
    }
    return data.sessions.map((session) =>
      parseSession(session, expectedHostId, expectedOwnerId),
    );
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
    const ownerId = uuid(data.ownerId, "owner id");
    const targetRuntimeId = uuid(data.targetRuntimeId, "target runtime id");
    if (
      ownerId !== input.controller.ownerId ||
      targetRuntimeId !== input.hostId
    ) {
      throw new Error(
        "Cloud pairing authority does not match the requested host.",
      );
    }
    const expiresAt = isoDate(data.expiresAt, "pairing expiration");
    const derivedTtlSeconds = Math.ceil(
      (Date.parse(expiresAt) - Date.now()) / 1_000,
    );
    const ttlSeconds =
      data.ttlSeconds === undefined
        ? derivedTtlSeconds
        : requiredInteger(data.ttlSeconds, "pairing TTL");
    if (ttlSeconds < 1 || ttlSeconds > 300) {
      throw new Error("Cloud response has an invalid pairing TTL.");
    }
    return {
      ownerId,
      sessionId: uuid(data.sessionId, "session id"),
      grantId: uuid(data.grantId, "grant id"),
      grantRevision: requiredInteger(data.grantRevision, "grant revision"),
      targetRuntimeId,
      targetKeyId: identifier(data.targetKeyId, "target key id"),
      code,
      expiresAt,
      grantExpiresAt: isoDate(data.grantExpiresAt, "grant expiration"),
      ttlSeconds,
      status: exactEnum(data.status, "pairing status", ["pending"]),
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
    const path = `/api/v1/remote/hosts/${encodeURIComponent(hostId)}/revoke`;
    while (true) {
      const data = await this.request<Record<string, unknown>>(path, {
        method: "POST",
      });
      const cleanup = record(data.cleanup);
      if (
        !cleanup ||
        typeof cleanup.more !== "boolean" ||
        !Number.isSafeInteger(cleanup.sessions) ||
        (cleanup.sessions as number) < 0 ||
        !Number.isSafeInteger(cleanup.commands) ||
        (cleanup.commands as number) < 0
      ) {
        throw new ElizaError(
          "Cloud response contains invalid host cleanup progress.",
          {
            code: "REMOTE_HOST_CLEANUP_PROGRESS_INVALID",
            context: { hostId, reason: "malformed_response" },
          },
        );
      }
      if (!cleanup.more) return;
      if (cleanup.sessions === 0 && cleanup.commands === 0) {
        throw new ElizaError(
          "Cloud host cleanup reported more work without making progress.",
          {
            code: "REMOTE_HOST_CLEANUP_PROGRESS_INVALID",
            context: { hostId, reason: "non_progressing_page" },
          },
        );
      }
    }
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
    const envelope = (
      value: unknown,
      kind: "start_receipt" | "result",
    ): EncryptedRemoteControlEnvelope | null => {
      if (value === null || value === undefined) return null;
      if (
        !isEncryptedRemoteControlEnvelope(value) ||
        value.messageKind !== kind ||
        value.sessionId !== input.sessionId ||
        value.commandId !== input.commandId
      ) {
        throw new Error(
          `Cloud response contains an invalid ${kind.replace("_", " ")} envelope.`,
        );
      }
      return value;
    };
    return {
      status: status as RemoteRelayCommandStatus,
      startReceipt: envelope(data.startReceipt, "start_receipt"),
      resultEnvelope: envelope(data.resultEnvelope, "result"),
    };
  }
}
