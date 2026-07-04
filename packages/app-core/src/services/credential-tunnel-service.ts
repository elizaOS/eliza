/**
 * Credential tunnel service — parent-side scoped credential delivery.
 *
 * When a spawned coding sub-agent needs a credential it cannot see (e.g.
 * `OPENAI_API_KEY` for a task that requires hitting the OpenAI API), the
 * orchestrator declares a *scope* on the parent runtime: a short-lived,
 * single-use bearer token that names exactly which keys the child is allowed
 * to pull. The parent's owner-only sensitive-request flow then collects the
 * value(s) from the user, encrypts each one with the scope's symmetric key
 * (AES-256-GCM), and the child redeems via the bridge HTTP endpoint by
 * presenting the bearer token. The ciphertext is deleted on redemption.
 *
 * Threat model:
 *   - Only `sha256(scopedToken)` is stored, so a memory snapshot of this
 *     process cannot reveal the bearer token.
 *   - Each scope has a 30-minute TTL.
 *   - One-shot per key: on first retrieve, the ciphertext is wiped and the
 *     key state is marked redeemed. A second retrieve rejects with
 *     `already_redeemed`.
 *   - Tunneling a key not pre-declared at scope creation is rejected.
 *   - The childSessionId is checked on both tunnel and retrieve.
 *
 * Crypto: AES-256-GCM with a per-tunnel random 12-byte IV. The auth tag is
 * appended to the ciphertext for transport. Only `node:crypto`.
 *
 * Logs intentionally exclude scoped tokens, ciphertexts, and credential
 * values. Only the scope id, child session id, and key names are logged.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  ChannelType,
  SUB_AGENT_CREDENTIAL_BRIDGE_ADAPTER_SERVICE as CORE_SUB_AGENT_CREDENTIAL_BRIDGE_ADAPTER_SERVICE,
  SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE as CORE_SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE,
  type SubAgentCredentialBridge as CoreSubAgentCredentialBridge,
  type SubAgentCredentialRequestOrigin as CoreSubAgentCredentialRequestOrigin,
  type DeliveryTarget,
  type DispatchSensitiveRequest,
  type IAgentRuntime,
  logger,
  SENSITIVE_REQUEST_DISPATCH_REGISTRY_SERVICE,
  type SensitiveRequest,
  type SensitiveRequestActorPolicy,
  type SensitiveRequestDeliveryMode,
  type SensitiveRequestDispatchRegistry,
  type SensitiveRequestPolicy,
  type SensitiveRequestSourceContext,
} from "@elizaos/core";

const TOKEN_BYTES = 32; // 256-bit
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const SCOPE_TTL_MS = 30 * 60 * 1000;
export const SUB_AGENT_CREDENTIAL_BRIDGE_ADAPTER_SERVICE =
  CORE_SUB_AGENT_CREDENTIAL_BRIDGE_ADAPTER_SERVICE;
export const SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE =
  CORE_SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE;

export interface DeclareScopeInput {
  childSessionId: string;
  credentialKeys: readonly string[];
}

export interface DeclareScopeResult {
  credentialScopeId: string;
  scopedToken: string;
  /** epoch ms */
  expiresAt: number;
}

export interface TunnelCredentialInput {
  childSessionId: string;
  credentialScopeId: string;
  key: string;
  value: string;
}

export interface RetrieveCredentialInput {
  childSessionId: string;
  key: string;
  scopedToken: string;
}

export type SubAgentCredentialRequestOrigin =
  CoreSubAgentCredentialRequestOrigin;

export interface SubAgentCredentialScopeResult extends DeclareScopeResult {
  sensitiveRequestIds: readonly string[];
}

export interface BridgeCredentialAdapter {
  requestCredentials(input: {
    childSessionId: string;
    credentialKeys: readonly string[];
    origin?: SubAgentCredentialRequestOrigin;
  }): Promise<SubAgentCredentialScopeResult>;
  tryRetrieveCredential(
    input: RetrieveCredentialInput,
  ): Promise<
    | { status: "pending" }
    | { status: "ready"; value: string }
    | { status: "expired" }
    | { status: "rejected"; reason: string }
  >;
}

export type SubAgentCredentialBridge = CoreSubAgentCredentialBridge;

interface ScopeEntryKeyState {
  /** Hex-encoded `IV || ciphertext || authTag`. Cleared after redemption. */
  encrypted: string | null;
  redeemed: boolean;
}

interface ScopeEntry {
  credentialScopeId: string;
  childSessionId: string;
  scopedTokenHash: string;
  /** sha256 of the raw token bytes — the AES-256-GCM symmetric key. */
  encryptionKey: Buffer;
  expiresAt: number;
  keys: Map<string, ScopeEntryKeyState>;
}

export class CredentialScopeError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "unknown_scope"
      | "scope_expired"
      | "session_mismatch"
      | "key_not_in_scope"
      | "already_redeemed"
      | "no_ciphertext"
      | "invalid_token",
    message: string,
  ) {
    super(message);
    this.name = "CredentialScopeError";
  }
}

function sha256(input: Buffer | string): Buffer {
  return createHash("sha256").update(input).digest();
}

function encrypt(value: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, authTag]).toString("hex");
}

function decrypt(encryptedHex: string, key: Buffer): string {
  const buf = Buffer.from(encryptedHex, "hex");
  if (buf.length < IV_BYTES + AUTH_TAG_BYTES + 1) {
    throw new Error("ciphertext_too_short");
  }
  const iv = buf.subarray(0, IV_BYTES);
  const authTag = buf.subarray(buf.length - AUTH_TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES, buf.length - AUTH_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

export interface CredentialTunnelService {
  declareScope(input: DeclareScopeInput): DeclareScopeResult;
  tunnelCredential(input: TunnelCredentialInput): void;
  retrieveCredential(input: RetrieveCredentialInput): string;
  expireScopes(now?: number): number;
  /** Test-only: peek at whether a scope still has ciphertext for a key. */
  hasCiphertext(credentialScopeId: string, key: string): boolean;
}

export function createCredentialTunnelService(options?: {
  ttlMs?: number;
  now?: () => number;
}): CredentialTunnelService {
  const ttlMs = options?.ttlMs ?? SCOPE_TTL_MS;
  const now = options?.now ?? (() => Date.now());
  // Primary index: sha256(scopedToken) hex → scope. The plaintext token is
  // never persisted in this process.
  const byTokenHash = new Map<string, ScopeEntry>();
  // Secondary index: scope id → scope. Used by tunnelCredential which only
  // has the scope id (the orchestrator that issued the token is the one
  // calling tunnel; it identifies the scope by id, not by re-presenting the
  // bearer token).
  const byId = new Map<string, ScopeEntry>();

  function dropScope(entry: ScopeEntry): void {
    byTokenHash.delete(entry.scopedTokenHash);
    byId.delete(entry.credentialScopeId);
  }

  function expiredAndDropped(entry: ScopeEntry, currentTime: number): boolean {
    if (entry.expiresAt <= currentTime) {
      dropScope(entry);
      return true;
    }
    return false;
  }

  return {
    declareScope({ childSessionId, credentialKeys }) {
      if (
        typeof childSessionId !== "string" ||
        childSessionId.trim().length === 0
      ) {
        throw new CredentialScopeError(
          "invalid_input",
          "childSessionId is required",
        );
      }
      if (!Array.isArray(credentialKeys) || credentialKeys.length === 0) {
        throw new CredentialScopeError(
          "invalid_input",
          "credentialKeys must be a non-empty array",
        );
      }
      const normalized = new Set<string>();
      for (const raw of credentialKeys) {
        if (typeof raw !== "string" || raw.trim().length === 0) {
          throw new CredentialScopeError(
            "invalid_input",
            "credentialKeys entries must be non-empty strings",
          );
        }
        normalized.add(raw.trim());
      }

      const tokenBytes = randomBytes(TOKEN_BYTES);
      const scopedToken = tokenBytes.toString("hex");
      const scopedTokenHash = sha256(tokenBytes).toString("hex");
      // The encryption key is sha256(token). Derived deterministically from
      // the bearer token, but kept on the scope entry so that
      // `tunnelCredential` (which does not see the token) can still encrypt.
      // Anyone who can read this Map already has memory access to the
      // ciphertexts, so colocating the key with the scope entry does not
      // weaken the threat model: the token hash is what gates retrieval.
      const encryptionKey = sha256(tokenBytes);
      const credentialScopeId = `cred_scope_${randomBytes(8).toString("hex")}`;
      const expiresAt = now() + ttlMs;

      const keys = new Map<string, ScopeEntryKeyState>();
      for (const key of normalized) {
        keys.set(key, { encrypted: null, redeemed: false });
      }

      const entry: ScopeEntry = {
        credentialScopeId,
        childSessionId: childSessionId.trim(),
        scopedTokenHash,
        encryptionKey,
        expiresAt,
        keys,
      };
      byTokenHash.set(scopedTokenHash, entry);
      byId.set(credentialScopeId, entry);

      return { credentialScopeId, scopedToken, expiresAt };
    },

    tunnelCredential({ childSessionId, credentialScopeId, key, value }) {
      if (typeof value !== "string" || value.length === 0) {
        throw new CredentialScopeError(
          "invalid_input",
          "value must be a non-empty string",
        );
      }
      const entry = byId.get(credentialScopeId);
      if (!entry) {
        throw new CredentialScopeError(
          "unknown_scope",
          "credentialScopeId not found",
        );
      }
      if (expiredAndDropped(entry, now())) {
        throw new CredentialScopeError("scope_expired", "scope expired");
      }
      if (entry.childSessionId !== childSessionId) {
        throw new CredentialScopeError(
          "session_mismatch",
          "childSessionId does not match scope owner",
        );
      }
      const state = entry.keys.get(key);
      if (!state) {
        throw new CredentialScopeError(
          "key_not_in_scope",
          `key ${key} not declared in scope`,
        );
      }
      if (state.redeemed) {
        throw new CredentialScopeError(
          "already_redeemed",
          `key ${key} already redeemed`,
        );
      }
      state.encrypted = encrypt(value, entry.encryptionKey);
    },

    retrieveCredential({ childSessionId, key, scopedToken }) {
      if (typeof scopedToken !== "string" || scopedToken.length === 0) {
        throw new CredentialScopeError(
          "invalid_token",
          "scopedToken is required",
        );
      }
      let tokenBytes: Buffer;
      try {
        tokenBytes = Buffer.from(scopedToken, "hex");
      } catch {
        throw new CredentialScopeError("invalid_token", "scopedToken invalid");
      }
      if (tokenBytes.length !== TOKEN_BYTES) {
        throw new CredentialScopeError(
          "invalid_token",
          "scopedToken length invalid",
        );
      }
      const tokenHash = sha256(tokenBytes).toString("hex");
      const entry = byTokenHash.get(tokenHash);
      if (!entry) {
        throw new CredentialScopeError(
          "invalid_token",
          "scopedToken does not match a known scope",
        );
      }
      if (expiredAndDropped(entry, now())) {
        throw new CredentialScopeError("scope_expired", "scope expired");
      }
      if (entry.childSessionId !== childSessionId) {
        throw new CredentialScopeError(
          "session_mismatch",
          "childSessionId does not match scope owner",
        );
      }
      const state = entry.keys.get(key);
      if (!state) {
        throw new CredentialScopeError(
          "key_not_in_scope",
          `key ${key} not in scope`,
        );
      }
      if (state.redeemed) {
        throw new CredentialScopeError(
          "already_redeemed",
          `key ${key} already redeemed`,
        );
      }
      if (!state.encrypted) {
        throw new CredentialScopeError(
          "no_ciphertext",
          `no value tunneled for ${key} yet`,
        );
      }
      const plaintext = decrypt(state.encrypted, entry.encryptionKey);
      state.encrypted = null;
      state.redeemed = true;

      // If every declared key has been redeemed, drop the scope so the
      // bearer token cannot be reused.
      let allRedeemed = true;
      for (const v of entry.keys.values()) {
        if (!v.redeemed) {
          allRedeemed = false;
          break;
        }
      }
      if (allRedeemed) dropScope(entry);

      return plaintext;
    },

    expireScopes(currentTime = now()) {
      let swept = 0;
      for (const entry of [...byTokenHash.values()]) {
        if (entry.expiresAt <= currentTime) {
          dropScope(entry);
          swept += 1;
        }
      }
      return swept;
    },

    hasCiphertext(credentialScopeId, key) {
      const entry = byId.get(credentialScopeId);
      if (!entry) return false;
      return entry.keys.get(key)?.encrypted != null;
    },
  };
}

function normalizeCredentialKeys(keys: readonly string[]): string[] {
  return Array.from(
    new Set(
      keys
        .map((key) => (typeof key === "string" ? key.trim() : ""))
        .filter(Boolean),
    ),
  );
}

function isDispatchRegistry(
  value: unknown,
): value is SensitiveRequestDispatchRegistry {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { get?: unknown }).get === "function" &&
    typeof (value as { list?: unknown }).list === "function"
  );
}

function readOrigin(
  value: SubAgentCredentialRequestOrigin | Record<string, unknown> | undefined,
): SubAgentCredentialRequestOrigin | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const roomId =
    typeof record.roomId === "string" && record.roomId.trim()
      ? record.roomId.trim()
      : undefined;
  const channelId =
    typeof record.channelId === "string" && record.channelId.trim()
      ? record.channelId.trim()
      : undefined;
  const source =
    typeof record.source === "string" && record.source.trim()
      ? record.source.trim()
      : undefined;
  const ownerEntityId =
    typeof record.ownerEntityId === "string" && record.ownerEntityId.trim()
      ? record.ownerEntityId.trim()
      : typeof record.userId === "string" && record.userId.trim()
        ? record.userId.trim()
        : undefined;
  if (!roomId && !channelId && !source && !ownerEntityId) return undefined;
  return { roomId, channelId, source, ownerEntityId };
}

function buildCredentialRequestPolicy(
  actorPolicy: "owner_only" | "owner_or_linked_identity",
  deliveryTarget: "dm" | "owner_app_inline",
): SensitiveRequestPolicy {
  return {
    actor: actorPolicy as SensitiveRequestActorPolicy,
    requirePrivateDelivery: true,
    requireAuthenticatedLink: true,
    allowInlineOwnerAppEntry: deliveryTarget === "owner_app_inline",
    allowPublicLink: false,
    allowDmFallback: deliveryTarget === "dm",
    allowTunnelLink: false,
    allowCloudLink: false,
  };
}

function deliveryModeFor(
  deliveryTarget: "dm" | "owner_app_inline",
): SensitiveRequestDeliveryMode {
  return deliveryTarget === "dm" ? "private_dm" : "inline_owner_app";
}

function sourceFor(
  deliveryTarget: "dm" | "owner_app_inline",
): SensitiveRequestSourceContext {
  return deliveryTarget === "dm" ? "dm" : "owner_app_private";
}

function buildCredentialDispatchRequest(input: {
  childSessionId: string;
  credentialScopeId: string;
  credentialKeys: readonly string[];
  expiresAt: number;
  agentId: string;
  actorPolicy: "owner_only" | "owner_or_linked_identity";
  deliveryTarget: "dm" | "owner_app_inline";
  origin?: SubAgentCredentialRequestOrigin;
}): SensitiveRequest {
  const {
    agentId,
    actorPolicy,
    childSessionId,
    credentialKeys,
    credentialScopeId,
    deliveryTarget,
    expiresAt,
    origin,
  } = input;
  const now = new Date().toISOString();
  const expiresIso = new Date(expiresAt).toISOString();
  const requestId = `cred_req_${randomBytes(8).toString("hex")}`;
  const keys = normalizeCredentialKeys(credentialKeys);
  const primaryKey = keys.length === 1 ? keys[0] : "SUB_AGENT_CREDENTIALS";
  const policy = buildCredentialRequestPolicy(actorPolicy, deliveryTarget);
  const mode = deliveryModeFor(deliveryTarget);
  const source = sourceFor(deliveryTarget);
  const countLabel = keys.length === 1 ? keys[0] : `${keys.length} credentials`;

  return {
    id: requestId,
    kind: "secret",
    status: "pending",
    agentId,
    organizationId: null,
    ownerEntityId: origin?.ownerEntityId ?? null,
    requesterEntityId: null,
    sourceRoomId: origin?.roomId ?? null,
    sourceChannelType: ChannelType.DM,
    sourcePlatform:
      deliveryTarget === "owner_app_inline"
        ? "owner_app"
        : (origin?.source ?? "dm"),
    target: {
      kind: "secret",
      key: primaryKey,
      scope: "agent",
    },
    policy,
    delivery: {
      kind: "secret",
      source,
      mode,
      policy,
      privateRouteRequired: true,
      publicLinkAllowed: false,
      authenticated: true,
      canCollectValueInCurrentChannel: deliveryTarget === "owner_app_inline",
      reason: `Sub-agent ${childSessionId} needs ${countLabel} to continue.`,
      instruction:
        "Enter the requested value in this secure owner-only form. The scoped token and credential value are never written to chat.",
      tunnel: {
        credentialScopeId,
        childSessionId,
        keys,
      },
    },
    expiresAt: expiresIso,
    fulfilledAt: null,
    canceledAt: null,
    expiredAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function toDispatchSensitiveRequest(
  request: SensitiveRequest,
): DispatchSensitiveRequest {
  return {
    ...request,
    delivery: { ...request.delivery },
  };
}

async function dispatchCredentialRequest(input: {
  dispatch: SensitiveRequestDispatchRegistry;
  runtime: IAgentRuntime;
  request: SensitiveRequest;
  deliveryTarget: "dm" | "owner_app_inline";
  origin?: SubAgentCredentialRequestOrigin;
}): Promise<string | null> {
  const target: DeliveryTarget =
    input.deliveryTarget === "dm" ? "dm" : "owner_app_inline";
  const channelId = input.origin?.channelId ?? input.origin?.roomId;
  const adapter =
    input.dispatch.resolve?.(target, channelId, input.runtime) ??
    input.dispatch.get(target);
  if (!adapter) {
    logger.warn(
      `[SubAgentCredentialBridge] no sensitive-request adapter registered for target=${target}`,
    );
    return null;
  }

  try {
    const result = await adapter.deliver({
      request: toDispatchSensitiveRequest(input.request),
      channelId,
      runtime: input.runtime,
    });
    if (!result.delivered) {
      logger.warn(
        `[SubAgentCredentialBridge] sensitive-request delivery failed target=${target} requestId=${input.request.id} error=${result.error ?? "unknown"}`,
      );
      return null;
    }
    return input.request.id;
  } catch (error) {
    logger.warn(
      `[SubAgentCredentialBridge] sensitive-request delivery threw requestId=${input.request.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

export function createSubAgentCredentialBridgeAdapter(options: {
  tunnel: CredentialTunnelService;
  dispatch: SensitiveRequestDispatchRegistry;
  runtime: IAgentRuntime;
}): BridgeCredentialAdapter & SubAgentCredentialBridge {
  const { dispatch, runtime, tunnel } = options;
  const agentId = String(
    (runtime as { agentId?: unknown }).agentId ?? "local-agent",
  );

  async function declareAndDispatch(input: {
    childSessionId: string;
    credentialKeys: readonly string[];
    actorPolicy?: "owner_only" | "owner_or_linked_identity";
    deliveryTarget?: "dm" | "owner_app_inline";
    origin?: SubAgentCredentialRequestOrigin;
  }): Promise<SubAgentCredentialScopeResult> {
    const credentialKeys = normalizeCredentialKeys(input.credentialKeys);
    const scope = tunnel.declareScope({
      childSessionId: input.childSessionId,
      credentialKeys,
    });
    const actorPolicy = input.actorPolicy ?? "owner_only";
    const deliveryTarget = input.deliveryTarget ?? "owner_app_inline";
    const origin = readOrigin(input.origin);
    const request = buildCredentialDispatchRequest({
      childSessionId: input.childSessionId,
      credentialScopeId: scope.credentialScopeId,
      credentialKeys,
      expiresAt: scope.expiresAt,
      agentId,
      actorPolicy,
      deliveryTarget,
      origin,
    });
    const requestId = await dispatchCredentialRequest({
      dispatch,
      runtime,
      request,
      deliveryTarget,
      origin,
    });
    return {
      ...scope,
      sensitiveRequestIds: requestId ? [requestId] : [],
    };
  }

  return {
    requestCredentials(input) {
      return declareAndDispatch({
        childSessionId: input.childSessionId,
        credentialKeys: input.credentialKeys,
        actorPolicy: "owner_only",
        deliveryTarget: "owner_app_inline",
        origin: input.origin,
      });
    },

    declareScope(input) {
      return declareAndDispatch(input);
    },

    async tunnelCredential(input) {
      tunnel.tunnelCredential(input);
    },

    async tryRetrieveCredential(input) {
      try {
        const value = tunnel.retrieveCredential(input);
        return { status: "ready", value };
      } catch (error) {
        if (error instanceof CredentialScopeError) {
          if (error.code === "no_ciphertext") return { status: "pending" };
          if (error.code === "scope_expired") return { status: "expired" };
          return { status: "rejected", reason: error.code };
        }
        return {
          status: "rejected",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

export function isSubAgentCredentialBridgeSandboxedEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(
    env.SANDBOX_AGENT_ID?.trim() ||
      env.SANDBOX_ROUTE_AGENT_ID?.trim() ||
      env.SANDBOX_SERVER_NAME?.trim() ||
      env.PARALLAX_SESSION_ID?.trim(),
  );
}

function setRuntimeService(
  runtime: IAgentRuntime,
  serviceName: string,
  service: unknown,
): void {
  const services = (runtime as { services?: Map<string, unknown[]> }).services;
  if (!services) return;
  services.set(serviceName, [service]);
}

export function registerSubAgentCredentialBridgeAdapter(
  runtime: IAgentRuntime,
  options?: {
    tunnel?: CredentialTunnelService;
    dispatch?: SensitiveRequestDispatchRegistry;
    env?: Record<string, string | undefined>;
  },
): boolean {
  if (isSubAgentCredentialBridgeSandboxedEnv(options?.env)) {
    logger.debug(
      "[SubAgentCredentialBridge] sandboxed runtime detected; skipping bridge adapter registration",
    );
    return false;
  }

  const dispatch =
    options?.dispatch ??
    (runtime as { getService?: (name: string) => unknown }).getService?.(
      SENSITIVE_REQUEST_DISPATCH_REGISTRY_SERVICE,
    );
  if (!isDispatchRegistry(dispatch)) {
    logger.debug(
      "[SubAgentCredentialBridge] sensitive-request dispatch registry missing; skipping bridge adapter registration",
    );
    return false;
  }

  const adapter = createSubAgentCredentialBridgeAdapter({
    tunnel: options?.tunnel ?? createCredentialTunnelService(),
    dispatch,
    runtime,
  });
  setRuntimeService(
    runtime,
    SUB_AGENT_CREDENTIAL_BRIDGE_ADAPTER_SERVICE,
    adapter,
  );
  setRuntimeService(runtime, SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE, adapter);
  logger.info(
    "[SubAgentCredentialBridge] registered credential bridge adapter services",
  );
  return true;
}
