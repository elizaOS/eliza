/**
 * Implements the bounded HTTPS relay client used only by the native target
 * process. Host and owner bearers are placed in request headers, never URLs or
 * returned diagnostics, and response bodies are rejected above a fixed limit.
 */

import { ElizaError } from "@elizaos/core";
import {
  canonicalizeRemoteControlValue,
  type EncryptedRemoteControlEnvelope,
  isEncryptedRemoteControlEnvelope,
  isRemoteControllerPublicIdentity,
  type RemoteControllerPublicIdentity,
} from "@elizaos/shared/contracts/remote-control";
import type { RemoteTargetManagedNetworkEnrollment } from "./remote-target-managed-network";
import type { EnrolledRemoteTargetVaultRecord } from "./remote-target-vault";

const RESPONSE_LIMIT_BYTES = 1_048_576;
const REQUEST_TIMEOUT_MS = 10_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RemoteTargetFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class RemoteTargetTransportError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    options?: ErrorOptions,
  ) {
    super(
      status > 0
        ? `Remote relay request failed with HTTP ${status}.`
        : "Remote relay request could not reach Eliza Cloud.",
      options,
    );
    this.name = "RemoteTargetTransportError";
  }
}

export interface RemoteTargetEnrollmentRequest {
  apiBaseUrl: string;
  ownerAccessToken: string;
  ownerId: string;
  deviceId: string;
  displayName: string;
  platform: "macos" | "windows" | "linux";
  runtimeKeyId: string;
  signingPublicKeyJwk: JsonWebKey;
  encryptionPublicKeyJwk: JsonWebKey;
  managedNetwork?: boolean;
}

export interface RemoteTargetEnrollmentResponse {
  hostId: string;
  hostToken: string;
  runtimeKeyId: string;
  status: "pending" | "active";
  createdAt: number;
  recovered: boolean;
  managedNetworkEnrollment?: RemoteTargetManagedNetworkEnrollment;
}

export interface RemoteTargetActivationResponse {
  sessionId: string;
  grantId: string;
  grantRevision: number;
  ownerId: string;
  controller: RemoteControllerPublicIdentity;
  targetRuntimeId: string;
  targetKeyId: string;
  grantExpiresAt: number;
  status: "active";
}

export interface RemoteTargetClaim {
  commandId: string;
  sequence: number;
  envelope: EncryptedRemoteControlEnvelope;
  claimAttempt: number;
  claimToken: string;
  claimExpiresAt: number;
}

export interface RemoteTargetHostRevocationPage {
  hostId: string;
  status: "revoked";
  alreadyRevoked: boolean;
  cleanup: { sessions: number; commands: number; more: boolean };
}

export interface RemoteTargetRelayTransport {
  enroll(
    input: RemoteTargetEnrollmentRequest,
  ): Promise<RemoteTargetEnrollmentResponse>;
  activateManagedNetwork(input: {
    enrollment: EnrolledRemoteTargetVaultRecord;
    expectedHostname: string;
  }): Promise<{ hostname: string }>;
  activate(input: {
    enrollment: EnrolledRemoteTargetVaultRecord;
    sessionId: string;
    code: string;
  }): Promise<RemoteTargetActivationResponse>;
  claimNext(input: {
    enrollment: EnrolledRemoteTargetVaultRecord;
    sessionId: string;
  }): Promise<RemoteTargetClaim | null>;
  recordStart(input: {
    enrollment: EnrolledRemoteTargetVaultRecord;
    sessionId: string;
    commandId: string;
    claimAttempt: number;
    claimToken: string;
    envelope: EncryptedRemoteControlEnvelope;
  }): Promise<void>;
  complete(input: {
    enrollment: EnrolledRemoteTargetVaultRecord;
    sessionId: string;
    commandId: string;
    claimAttempt: number;
    claimToken: string;
    envelope: EncryptedRemoteControlEnvelope;
  }): Promise<void>;
  revokeHost(input: {
    enrollment: EnrolledRemoteTargetVaultRecord;
  }): Promise<RemoteTargetHostRevocationPage>;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Remote relay response is invalid.");
  }
  return value as Record<string, unknown>;
}

function requireUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error("Remote relay response contains an invalid identifier.");
  }
  return value;
}

function requireTimestamp(value: unknown): number {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("Remote relay response contains an invalid timestamp.");
  }
  return parsed;
}

export function normalizeRemoteTargetApiBase(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // error-policy:J3 renderer-provided URLs are untrusted input.
    throw new Error("Remote target API URL is invalid.");
  }
  const isLoopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Remote target API must use HTTPS (HTTP is limited to loopback development).",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > RESPONSE_LIMIT_BYTES) {
    throw new Error("Remote relay response is too large.");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        total += item.value.byteLength;
        if (total > RESPONSE_LIMIT_BYTES) {
          await reader.cancel();
          throw new Error("Remote relay response is too large.");
        }
        chunks.push(item.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    // error-policy:J3 remote response bytes are untrusted input.
    throw new Error("Remote relay response is invalid JSON.");
  }
}

export class HttpRemoteTargetRelayTransport
  implements RemoteTargetRelayTransport
{
  constructor(
    private readonly fetchImpl: RemoteTargetFetch = globalThis.fetch,
    private readonly requestTimeoutMs = REQUEST_TIMEOUT_MS,
  ) {}

  private async request(
    apiBaseUrl: string,
    path: string,
    init: RequestInit,
    allowEmpty = false,
  ): Promise<unknown | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(
          `${normalizeRemoteTargetApiBase(apiBaseUrl)}${path}`,
          {
            ...init,
            cache: "no-store",
            redirect: "error",
            signal: controller.signal,
          },
        );
      } catch (error) {
        // error-policy:J2 normalize only failures raised by the network
        // dispatch; response parsing and validation failures remain visible.
        if (error instanceof Error && error.name === "AbortError") {
          throw new RemoteTargetTransportError("REQUEST_TIMEOUT", 0, {
            cause: error,
          });
        }
        if (error instanceof TypeError) {
          throw new RemoteTargetTransportError("NETWORK_UNAVAILABLE", 0, {
            cause: error,
          });
        }
        throw error;
      }
      if (allowEmpty && response.status === 204) return null;
      const body = await readBoundedJson(response);
      const root = requireObject(body);
      if (!response.ok) {
        throw new RemoteTargetTransportError(
          typeof root.code === "string" ? root.code : `HTTP_${response.status}`,
          response.status,
        );
      }
      if (root.success !== true)
        throw new Error("Remote relay request failed.");
      return requireObject(root.data);
    } finally {
      clearTimeout(timeout);
    }
  }

  async enroll(
    input: RemoteTargetEnrollmentRequest,
  ): Promise<RemoteTargetEnrollmentResponse> {
    if (input.ownerAccessToken.trim().length < 16) {
      throw new Error("Owner authentication is required for enrollment.");
    }
    const listedBefore = requireObject(
      await this.request(input.apiBaseUrl, "/api/v1/remote/hosts", {
        method: "GET",
        headers: { Authorization: `Bearer ${input.ownerAccessToken}` },
      }),
    );
    if (
      listedBefore.ownerId !== input.ownerId ||
      !Array.isArray(listedBefore.hosts)
    ) {
      throw new Error("Remote host enrollment owner binding is invalid.");
    }
    const expectedPublic = {
      deviceId: input.deviceId,
      displayName: input.displayName,
      platform: input.platform,
      connectionMode: "relay",
      runtimeKeyId: input.runtimeKeyId,
      signingPublicKeyJwk: input.signingPublicKeyJwk,
      encryptionPublicKeyJwk: input.encryptionPublicKeyJwk,
    };
    const identityMatches = listedBefore.hosts.filter(
      (host) =>
        typeof host === "object" &&
        host !== null &&
        canonicalizeRemoteControlValue({
          deviceId: Reflect.get(host, "deviceId"),
          displayName: Reflect.get(host, "displayName"),
          platform: Reflect.get(host, "platform"),
          connectionMode: Reflect.get(host, "connectionMode"),
          runtimeKeyId: Reflect.get(host, "runtimeKeyId"),
          signingPublicKeyJwk: Reflect.get(host, "signingPublicKeyJwk"),
          encryptionPublicKeyJwk: Reflect.get(host, "encryptionPublicKeyJwk"),
        }) === canonicalizeRemoteControlValue(expectedPublic),
    );
    const matchingHosts = identityMatches.filter(
      (host) =>
        Reflect.get(host, "status") === "active" &&
        Reflect.get(host, "revokedAt") === null,
    );
    if (matchingHosts.length > 1) {
      throw new Error("Remote host recovery identity is ambiguous.");
    }
    if (
      identityMatches.some((host) => Reflect.get(host, "status") === "pending")
    ) {
      throw new RemoteTargetTransportError("MANAGED_ENROLLMENT_PENDING", 409);
    }
    if (
      identityMatches.some((host) => Reflect.get(host, "status") === "revoked")
    ) {
      throw new RemoteTargetTransportError("REMOTE_HOST_REVOKED", 409);
    }
    const recoveryHostId = matchingHosts[0]
      ? requireUuid(Reflect.get(matchingHosts[0], "id"))
      : null;
    const data = requireObject(
      await this.request(input.apiBaseUrl, "/api/v1/remote/hosts", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.ownerAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          deviceId: input.deviceId,
          displayName: input.displayName,
          platform: input.platform,
          connectionMode: "relay",
          runtimeKeyId: input.runtimeKeyId,
          signingPublicKeyJwk: input.signingPublicKeyJwk,
          encryptionPublicKeyJwk: input.encryptionPublicKeyJwk,
          ...(input.managedNetwork ? { managedNetwork: true } : {}),
          ...(recoveryHostId ? { recoveryHostId } : {}),
        }),
      }),
    );
    const hostId = requireUuid(data.hostId);
    const createdAt = requireTimestamp(data.createdAt);
    if (
      typeof data.hostToken !== "string" ||
      !/^rhost_v1_[A-Za-z0-9_-]{43}$/.test(data.hostToken) ||
      typeof data.runtimeKeyId !== "string" ||
      data.runtimeKeyId !== input.runtimeKeyId ||
      (data.status !== "active" && data.status !== "pending") ||
      typeof data.recovered !== "boolean"
    ) {
      throw new Error("Remote host enrollment response is invalid.");
    }

    const listed = requireObject(
      await this.request(input.apiBaseUrl, "/api/v1/remote/hosts", {
        method: "GET",
        headers: { Authorization: `Bearer ${input.ownerAccessToken}` },
      }),
    );
    if (listed.ownerId !== input.ownerId || !Array.isArray(listed.hosts)) {
      throw new Error("Remote host enrollment owner binding is invalid.");
    }
    const confirmed = listed.hosts.find(
      (host) =>
        typeof host === "object" &&
        host !== null &&
        Reflect.get(host, "id") === hostId &&
        requireTimestamp(Reflect.get(host, "createdAt")) === createdAt &&
        canonicalizeRemoteControlValue({
          deviceId: Reflect.get(host, "deviceId"),
          displayName: Reflect.get(host, "displayName"),
          platform: Reflect.get(host, "platform"),
          connectionMode: Reflect.get(host, "connectionMode"),
          runtimeKeyId: Reflect.get(host, "runtimeKeyId"),
          signingPublicKeyJwk: Reflect.get(host, "signingPublicKeyJwk"),
          encryptionPublicKeyJwk: Reflect.get(host, "encryptionPublicKeyJwk"),
        }) === canonicalizeRemoteControlValue(expectedPublic),
    );
    if (!confirmed) {
      throw new Error("Remote host enrollment could not be verified.");
    }
    let managedNetworkEnrollment:
      | RemoteTargetManagedNetworkEnrollment
      | undefined;
    if (input.managedNetwork) {
      const managed = requireObject(data.managedNetworkEnrollment);
      const expiresAt = requireTimestamp(managed.expiresAt);
      if (
        data.status !== "pending" ||
        typeof managed.loginServer !== "string" ||
        typeof managed.authKey !== "string" ||
        typeof managed.hostname !== "string"
      ) {
        throw new Error("Managed network enrollment response is invalid.");
      }
      managedNetworkEnrollment = {
        loginServer: managed.loginServer,
        authKey: managed.authKey,
        hostname: managed.hostname,
        expiresAt,
      };
    } else if (
      data.status !== "active" ||
      data.managedNetworkEnrollment != null
    ) {
      throw new Error("Remote host enrollment response is invalid.");
    }
    return {
      hostId,
      hostToken: data.hostToken,
      runtimeKeyId: data.runtimeKeyId,
      status: data.status,
      createdAt,
      recovered: data.recovered,
      ...(managedNetworkEnrollment ? { managedNetworkEnrollment } : {}),
    };
  }

  async activateManagedNetwork(input: {
    enrollment: EnrolledRemoteTargetVaultRecord;
    expectedHostname: string;
  }): Promise<{ hostname: string }> {
    const hostId = requireUuid(input.enrollment.identity.runtimeId);
    const data = requireObject(
      await this.request(
        input.enrollment.apiBaseUrl,
        `/api/v1/remote/hosts/${encodeURIComponent(hostId)}/managed-network/activate`,
        {
          method: "POST",
          headers: this.hostHeaders(input.enrollment),
        },
      ),
    );
    const escaped = input.expectedHostname.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    if (
      data.hostId !== hostId ||
      data.status !== "active" ||
      typeof data.hostname !== "string" ||
      !new RegExp(`^${escaped}(?:-[a-z0-9]{8})?$`).test(data.hostname)
    ) {
      throw new Error("Managed network activation response is invalid.");
    }
    return { hostname: data.hostname };
  }

  async activate(input: {
    enrollment: EnrolledRemoteTargetVaultRecord;
    sessionId: string;
    code: string;
  }): Promise<RemoteTargetActivationResponse> {
    const sessionId = requireUuid(input.sessionId);
    if (!/^\d{6}$/.test(input.code)) {
      throw new Error("Pairing code must contain exactly six digits.");
    }
    const data = requireObject(
      await this.request(
        input.enrollment.apiBaseUrl,
        `/api/v1/remote/sessions/${encodeURIComponent(sessionId)}/activate`,
        {
          method: "POST",
          headers: this.hostHeaders(input.enrollment, true),
          body: JSON.stringify({ code: input.code }),
        },
      ),
    );
    const controller: RemoteControllerPublicIdentity = {
      version: 1,
      role: "controller",
      ownerId: data.ownerId as string,
      deviceId: data.controllerDeviceId as string,
      keyId: data.controllerKeyId as string,
      displayName: data.controllerDisplayName as string,
      platform:
        data.controllerPlatform as RemoteControllerPublicIdentity["platform"],
      signingPublicKeyJwk: data.controllerSigningPublicKeyJwk as JsonWebKey,
      encryptionPublicKeyJwk:
        data.controllerEncryptionPublicKeyJwk as JsonWebKey,
      createdAt: requireTimestamp(data.controllerCreatedAt),
    };
    if (
      data.sessionId !== sessionId ||
      data.status !== "active" ||
      !Number.isSafeInteger(data.grantRevision) ||
      (data.grantRevision as number) < 1 ||
      !isRemoteControllerPublicIdentity(controller)
    ) {
      throw new Error("Remote session activation response is invalid.");
    }
    return {
      sessionId,
      grantId: requireUuid(data.grantId),
      grantRevision: data.grantRevision as number,
      ownerId: controller.ownerId,
      controller,
      targetRuntimeId: requireUuid(data.targetRuntimeId),
      targetKeyId:
        typeof data.targetKeyId === "string" &&
        /^[A-Za-z0-9._:-]{1,256}$/.test(data.targetKeyId)
          ? data.targetKeyId
          : (() => {
              throw new Error("Remote activation target key is invalid.");
            })(),
      grantExpiresAt: requireTimestamp(data.grantExpiresAt),
      status: "active",
    };
  }

  async claimNext(input: {
    enrollment: EnrolledRemoteTargetVaultRecord;
    sessionId: string;
  }): Promise<RemoteTargetClaim | null> {
    const data = await this.request(
      input.enrollment.apiBaseUrl,
      `/api/v1/remote/sessions/${encodeURIComponent(requireUuid(input.sessionId))}/commands`,
      { method: "GET", headers: this.hostHeaders(input.enrollment) },
      true,
    );
    if (data === null) return null;
    const body = requireObject(data);
    if (
      !Number.isSafeInteger(body.sequence) ||
      !Number.isSafeInteger(body.claimAttempt) ||
      (body.claimAttempt as number) < 1 ||
      typeof body.claimToken !== "string" ||
      !UUID_PATTERN.test(body.claimToken) ||
      !isEncryptedRemoteControlEnvelope(body.envelope) ||
      body.envelope.messageKind !== "command"
    ) {
      throw new Error("Remote command claim is invalid.");
    }
    const commandId = requireUuid(body.commandId);
    if (
      body.envelope.sessionId !== input.sessionId ||
      body.envelope.commandId !== commandId ||
      body.envelope.sequence !== body.sequence ||
      body.envelope.targetRuntimeId !== input.enrollment.identity.runtimeId ||
      body.envelope.targetKeyId !== input.enrollment.identity.keyId ||
      body.envelope.ownerId !== input.enrollment.identity.ownerId
    ) {
      throw new Error("Remote command claim binding is invalid.");
    }
    return {
      commandId,
      sequence: body.sequence as number,
      envelope: body.envelope,
      claimAttempt: body.claimAttempt as number,
      claimToken: body.claimToken,
      claimExpiresAt: requireTimestamp(body.claimExpiresAt),
    };
  }

  async recordStart(input: {
    enrollment: EnrolledRemoteTargetVaultRecord;
    sessionId: string;
    commandId: string;
    claimAttempt: number;
    claimToken: string;
    envelope: EncryptedRemoteControlEnvelope;
  }): Promise<void> {
    await this.commandMutation("start", input);
  }

  async complete(input: {
    enrollment: EnrolledRemoteTargetVaultRecord;
    sessionId: string;
    commandId: string;
    claimAttempt: number;
    claimToken: string;
    envelope: EncryptedRemoteControlEnvelope;
  }): Promise<void> {
    await this.commandMutation("complete", input);
  }

  async revokeHost(input: {
    enrollment: EnrolledRemoteTargetVaultRecord;
  }): Promise<RemoteTargetHostRevocationPage> {
    const hostId = requireUuid(input.enrollment.identity.runtimeId);
    const data = requireObject(
      await this.request(
        input.enrollment.apiBaseUrl,
        `/api/v1/remote/hosts/${encodeURIComponent(hostId)}/revoke`,
        {
          method: "POST",
          headers: this.hostHeaders(input.enrollment),
        },
      ),
    );
    const cleanup = requireObject(data.cleanup);
    if (
      data.id !== hostId ||
      data.status !== "revoked" ||
      typeof data.alreadyRevoked !== "boolean" ||
      !Number.isSafeInteger(cleanup.sessions) ||
      (cleanup.sessions as number) < 0 ||
      !Number.isSafeInteger(cleanup.commands) ||
      (cleanup.commands as number) < 0 ||
      typeof cleanup.more !== "boolean"
    ) {
      throw new ElizaError("Remote host revocation response is invalid", {
        code: "REMOTE_HOST_REVOCATION_RESPONSE_INVALID",
        context: { hostId },
      });
    }
    return {
      hostId,
      status: "revoked",
      alreadyRevoked: data.alreadyRevoked,
      cleanup: {
        sessions: cleanup.sessions as number,
        commands: cleanup.commands as number,
        more: cleanup.more,
      },
    };
  }

  private async commandMutation(
    operation: "start" | "complete",
    input: {
      enrollment: EnrolledRemoteTargetVaultRecord;
      sessionId: string;
      commandId: string;
      claimAttempt: number;
      claimToken: string;
      envelope: EncryptedRemoteControlEnvelope;
    },
  ): Promise<void> {
    await this.request(
      input.enrollment.apiBaseUrl,
      `/api/v1/remote/sessions/${encodeURIComponent(requireUuid(input.sessionId))}/commands/${encodeURIComponent(input.commandId)}/${operation}`,
      {
        method: "POST",
        headers: this.hostHeaders(input.enrollment, true),
        body: JSON.stringify({
          claimAttempt: input.claimAttempt,
          claimToken: input.claimToken,
          envelope: input.envelope,
        }),
      },
    );
  }

  private hostHeaders(
    enrollment: EnrolledRemoteTargetVaultRecord,
    json = false,
  ): Record<string, string> {
    return {
      Authorization: `Bearer ${enrollment.hostToken}`,
      "X-Remote-Host-Id": enrollment.identity.runtimeId,
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }
}

export const remoteTargetTransportInternals = {
  RESPONSE_LIMIT_BYTES,
  normalizeRemoteTargetApiBase,
  readBoundedJson,
};
