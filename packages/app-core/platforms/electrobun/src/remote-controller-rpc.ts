/**
 * Owns the desktop controller's ECDSA/ECDH identity and remote-command crypto.
 * Private JWKs are generated and retained in the operating system credential
 * service; renderer RPC exposes only public identity, encrypted envelopes, and
 * verified command results.
 */
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  canonicalizeRemoteControlValue,
  type EncryptedRemoteControlEnvelope,
  isEncryptedRemoteControlEnvelope,
  isRemoteCommandAction,
  REMOTE_COMMAND_MAX_TTL_MS,
  REMOTE_CONTROL_PROTOCOL_VERSION,
  type RemoteCommandBody,
  type RemoteControllerPlatform,
  type RemoteControllerPublicIdentity,
  type RemoteJsonValue,
  type RemoteTargetPublicIdentity,
  type SignedRemoteCommand,
  type SignedRemoteCommandResult,
  type SignedRemoteCommandStartReceipt,
} from "@elizaos/shared/contracts/remote-control";
import type { PlatformSecureStore } from "../../../src/security/platform-secure-store";
import { createNodePlatformSecureStore } from "../../../src/security/platform-secure-store-node";
import {
  digestRemotePayload,
  openRemoteControlMessage,
  sealRemoteControlMessage,
  signRemoteCommand,
  verifyRemoteCommandResult,
  verifyRemoteCommandStartReceipt,
} from "../../../src/security/remote-control-crypto";

interface StoredControllerIdentity {
  version: 1;
  identity: RemoteControllerPublicIdentity;
  signingPrivateKeyJwk: JsonWebKey;
  encryptionPrivateKeyJwk: JsonWebKey;
  sessionSequences?: Record<
    string,
    { bindingDigest: string; sequence: number }
  >;
}

const store = createNodePlatformSecureStore();
const controllerMutationTails = new Map<string, Promise<void>>();
const CONTROLLER_DEVICE_VAULT_ID = "remote-controller-device-v1";

async function withControllerMutation<T>(
  vaultId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const predecessor = controllerMutationTails.get(vaultId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = predecessor.catch(() => undefined).then(() => current);
  controllerMutationTails.set(vaultId, queued);
  await predecessor.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (controllerMutationTails.get(vaultId) === queued) {
      controllerMutationTails.delete(vaultId);
    }
  }
}

function controllerVaultId(ownerId: string, deviceId: string): string {
  return `remote-controller-${createHash("sha256")
    .update(`${ownerId}\0${deviceId}`)
    .digest("hex")}`;
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(value.trim())
  );
}

function isPrivateP256Jwk(value: unknown): value is JsonWebKey {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const key = value as Record<string, unknown>;
  return (
    key.kty === "EC" &&
    key.crv === "P-256" &&
    typeof key.x === "string" &&
    typeof key.y === "string" &&
    typeof key.d === "string"
  );
}

function parseStoredIdentity(value: string): StoredControllerIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    // error-policy:J3 native credential-store contents are untrusted input.
    throw new Error("Stored controller identity is corrupt.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Stored controller identity is corrupt.");
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.identity !== "object" ||
    record.identity === null ||
    !isPrivateP256Jwk(record.signingPrivateKeyJwk) ||
    !isPrivateP256Jwk(record.encryptionPrivateKeyJwk)
  ) {
    throw new Error("Stored controller identity is corrupt.");
  }
  const identity = record.identity as RemoteControllerPublicIdentity;
  if (
    identity.version !== REMOTE_CONTROL_PROTOCOL_VERSION ||
    identity.role !== "controller" ||
    !isIdentifier(identity.ownerId) ||
    !isIdentifier(identity.deviceId) ||
    !isIdentifier(identity.keyId)
  ) {
    throw new Error("Stored controller identity is corrupt.");
  }
  const sessionSequences = record.sessionSequences;
  if (
    sessionSequences !== undefined &&
    (typeof sessionSequences !== "object" ||
      sessionSequences === null ||
      Array.isArray(sessionSequences) ||
      Object.values(sessionSequences).some(
        (entry) =>
          typeof entry !== "object" ||
          entry === null ||
          typeof Reflect.get(entry, "bindingDigest") !== "string" ||
          !Number.isSafeInteger(Reflect.get(entry, "sequence")) ||
          Number(Reflect.get(entry, "sequence")) < 1,
      ))
  ) {
    throw new Error("Stored controller identity is corrupt.");
  }
  return {
    version: 1,
    identity,
    signingPrivateKeyJwk: record.signingPrivateKeyJwk,
    encryptionPrivateKeyJwk: record.encryptionPrivateKeyJwk,
    ...(sessionSequences
      ? {
          sessionSequences:
            sessionSequences as StoredControllerIdentity["sessionSequences"],
        }
      : {}),
  };
}

function publicJwk(privateKeyJwk: JsonWebKey): JsonWebKey {
  const { d: _privateScalar, ...publicFields } = privateKeyJwk;
  return publicFields;
}

function generatePrivateP256Jwk(): JsonWebKey {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return pair.privateKey.export({ format: "jwk" });
}

function identityKeyId(
  signingPublicKeyJwk: JsonWebKey,
  encryptionPublicKeyJwk: JsonWebKey,
): string {
  return `p256:${createHash("sha256")
    .update(
      canonicalizeRemoteControlValue({
        signingPublicKeyJwk,
        encryptionPublicKeyJwk,
      }),
    )
    .digest("base64url")}`;
}

function readIdentityRequest(params: unknown): {
  ownerId: string;
  deviceId: string | null;
  displayName: string;
  platform: RemoteControllerPlatform;
} {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("Controller identity parameters are required.");
  }
  const ownerId = Reflect.get(params, "ownerId");
  const deviceId = Reflect.get(params, "deviceId");
  const displayName = Reflect.get(params, "displayName");
  const platform = Reflect.get(params, "platform");
  if (
    !isIdentifier(ownerId) ||
    (deviceId !== undefined && !isIdentifier(deviceId)) ||
    typeof displayName !== "string" ||
    displayName.trim().length === 0 ||
    displayName.trim().length > 128 ||
    !["macos", "windows", "linux", "ios", "android", "web"].includes(
      String(platform),
    )
  ) {
    throw new Error("Controller identity fields are invalid.");
  }
  return {
    ownerId: ownerId.trim(),
    deviceId: typeof deviceId === "string" ? deviceId.trim() : null,
    displayName: displayName.trim(),
    platform: platform as RemoteControllerPlatform,
  };
}

async function nativeControllerDeviceId(
  nativeStore: PlatformSecureStore,
): Promise<string> {
  return withControllerMutation(CONTROLLER_DEVICE_VAULT_ID, async () => {
    const existing = await nativeStore.get(
      CONTROLLER_DEVICE_VAULT_ID,
      "runtime.agent_profiles",
    );
    if (existing.ok) {
      if (!isIdentifier(existing.value)) {
        throw new Error("Stored controller device identity is corrupt.");
      }
      return existing.value;
    }
    if (existing.reason !== "not_found") {
      throw new Error("Secure controller device storage is unavailable.");
    }
    const created = randomUUID();
    const persisted = await nativeStore.set(
      CONTROLLER_DEVICE_VAULT_ID,
      "runtime.agent_profiles",
      created,
    );
    if (!persisted.ok) {
      throw new Error("Secure controller device storage is unavailable.");
    }
    return created;
  });
}

async function loadControllerIdentity(
  ownerId: string,
  deviceId: string,
  nativeStore: PlatformSecureStore = store,
): Promise<StoredControllerIdentity | null> {
  const result = await nativeStore.get(
    controllerVaultId(ownerId, deviceId),
    "runtime.agent_profiles",
  );
  if (!result.ok) {
    if (result.reason === "not_found") return null;
    throw new Error("Secure controller identity storage is unavailable.");
  }
  const stored = parseStoredIdentity(result.value);
  if (
    stored.identity.ownerId !== ownerId ||
    stored.identity.deviceId !== deviceId
  ) {
    throw new Error("Stored controller identity binding is invalid.");
  }
  return stored;
}

export async function desktopGetOrCreateControllerIdentity(
  params: unknown,
  nativeStore: PlatformSecureStore = store,
): Promise<RemoteControllerPublicIdentity> {
  const request = readIdentityRequest(params);
  const deviceId =
    request.deviceId ?? (await nativeControllerDeviceId(nativeStore));
  const vaultId = controllerVaultId(request.ownerId, deviceId);
  return withControllerMutation(vaultId, async () => {
    const existing = await loadControllerIdentity(
      request.ownerId,
      deviceId,
      nativeStore,
    );
    if (existing) return existing.identity;

    const signingPrivateKeyJwk = generatePrivateP256Jwk();
    const encryptionPrivateKeyJwk = generatePrivateP256Jwk();
    const signingPublicKeyJwk = publicJwk(signingPrivateKeyJwk);
    const encryptionPublicKeyJwk = publicJwk(encryptionPrivateKeyJwk);
    const identity: RemoteControllerPublicIdentity = {
      version: REMOTE_CONTROL_PROTOCOL_VERSION,
      role: "controller",
      ownerId: request.ownerId,
      deviceId,
      keyId: identityKeyId(signingPublicKeyJwk, encryptionPublicKeyJwk),
      displayName: request.displayName,
      platform: request.platform,
      signingPublicKeyJwk,
      encryptionPublicKeyJwk,
      createdAt: Date.now(),
    };
    const stored: StoredControllerIdentity = {
      version: 1,
      identity,
      signingPrivateKeyJwk,
      encryptionPrivateKeyJwk,
    };
    const result = await nativeStore.set(
      vaultId,
      "runtime.agent_profiles",
      JSON.stringify(stored),
    );
    if (!result.ok) {
      throw new Error("Secure controller identity storage is unavailable.");
    }
    return identity;
  });
}

function asRemoteJsonValue(value: unknown): RemoteJsonValue {
  canonicalizeRemoteControlValue(value);
  return value as RemoteJsonValue;
}

export async function desktopCreateRemoteCommand(params: unknown): Promise<{
  commandId: string;
  expiresAt: number;
  command: SignedRemoteCommand;
  envelope: EncryptedRemoteControlEnvelope;
}>;
export async function desktopCreateRemoteCommand(
  params: unknown,
  nativeStore?: PlatformSecureStore,
): Promise<{
  commandId: string;
  expiresAt: number;
  command: SignedRemoteCommand;
  envelope: EncryptedRemoteControlEnvelope;
}>;
export async function desktopCreateRemoteCommand(
  params: unknown,
  nativeStore: PlatformSecureStore = store,
): Promise<{
  commandId: string;
  expiresAt: number;
  command: SignedRemoteCommand;
  envelope: EncryptedRemoteControlEnvelope;
}> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("Remote command parameters are required.");
  }
  const record = params as Record<string, unknown>;
  const identifiers = [
    record.ownerId,
    record.grantId,
    record.sessionId,
    record.controllerDeviceId,
    record.controllerKeyId,
    record.targetRuntimeId,
    record.targetKeyId,
  ];
  if (
    !identifiers.every(isIdentifier) ||
    !Number.isSafeInteger(record.grantRevision) ||
    (record.grantRevision as number) < 1 ||
    !isRemoteCommandAction(record.action) ||
    typeof record.targetEncryptionPublicKeyJwk !== "object" ||
    record.targetEncryptionPublicKeyJwk === null
  ) {
    throw new Error("Remote command authority is invalid.");
  }
  const ownerId = record.ownerId as string;
  const controllerDeviceId = record.controllerDeviceId as string;
  const vaultId = controllerVaultId(ownerId, controllerDeviceId);
  return withControllerMutation(vaultId, async () => {
    const stored = await loadControllerIdentity(
      ownerId,
      controllerDeviceId,
      nativeStore,
    );
    if (!stored || stored.identity.keyId !== record.controllerKeyId) {
      throw new Error("Controller identity is unavailable or changed.");
    }
    const bindingDigest = createHash("sha256")
      .update(
        canonicalizeRemoteControlValue({
          ownerId,
          grantId: record.grantId,
          grantRevision: record.grantRevision,
          sessionId: record.sessionId,
          controllerDeviceId,
          controllerKeyId: record.controllerKeyId,
          targetRuntimeId: record.targetRuntimeId,
          targetKeyId: record.targetKeyId,
        }),
      )
      .digest("base64url");
    const sequences = { ...(stored.sessionSequences ?? {}) };
    const previous = sequences[record.sessionId as string];
    const sequence =
      previous?.bindingDigest === bindingDigest ? previous.sequence + 1 : 1;
    sequences[record.sessionId as string] = { bindingDigest, sequence };
    const persisted = await nativeStore.set(
      vaultId,
      "runtime.agent_profiles",
      JSON.stringify({ ...stored, sessionSequences: sequences }),
    );
    if (!persisted.ok) {
      throw new Error("Secure remote sequence storage is unavailable.");
    }
    const issuedAt = Date.now();
    const commandId = randomUUID();
    const payload = asRemoteJsonValue(record.payload);
    const body: RemoteCommandBody = {
      version: REMOTE_CONTROL_PROTOCOL_VERSION,
      ownerId: record.ownerId as string,
      grantId: record.grantId as string,
      grantRevision: record.grantRevision as number,
      sessionId: record.sessionId as string,
      controllerDeviceId: record.controllerDeviceId as string,
      controllerKeyId: record.controllerKeyId as string,
      targetRuntimeId: record.targetRuntimeId as string,
      targetKeyId: record.targetKeyId as string,
      commandId,
      sequence,
      nonce: randomUUID(),
      issuedAt,
      expiresAt: issuedAt + REMOTE_COMMAND_MAX_TTL_MS,
      action: record.action as RemoteCommandBody["action"],
      payload,
      payloadDigest: digestRemotePayload(payload),
    };
    const command = signRemoteCommand(body, stored.signingPrivateKeyJwk);
    const scope = {
      ...body,
      messageKind: "command" as const,
      senderKeyId: body.controllerKeyId,
      recipientKeyId: body.targetKeyId,
    };
    return {
      commandId,
      expiresAt: body.expiresAt,
      command,
      envelope: sealRemoteControlMessage(
        command,
        scope,
        record.targetEncryptionPublicKeyJwk as JsonWebKey,
      ),
    };
  });
}

export async function desktopClearRemoteSessionState(
  params: unknown,
  nativeStore: PlatformSecureStore = store,
): Promise<{ cleared: boolean }> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("Remote session cleanup parameters are required.");
  }
  const ownerId = Reflect.get(params, "ownerId");
  const controllerDeviceId = Reflect.get(params, "controllerDeviceId");
  const sessionId = Reflect.get(params, "sessionId");
  if (
    !isIdentifier(ownerId) ||
    !isIdentifier(controllerDeviceId) ||
    !isIdentifier(sessionId)
  ) {
    throw new Error("Remote session cleanup authority is invalid.");
  }
  const vaultId = controllerVaultId(ownerId, controllerDeviceId);
  return withControllerMutation(vaultId, async () => {
    const stored = await loadControllerIdentity(
      ownerId,
      controllerDeviceId,
      nativeStore,
    );
    if (!stored?.sessionSequences?.[sessionId]) return { cleared: false };
    const sessionSequences = { ...stored.sessionSequences };
    delete sessionSequences[sessionId];
    const persisted = await nativeStore.set(
      vaultId,
      "runtime.agent_profiles",
      JSON.stringify({ ...stored, sessionSequences }),
    );
    if (!persisted.ok) {
      throw new Error("Secure remote session cleanup is unavailable.");
    }
    return { cleared: true };
  });
}

export async function desktopOpenRemoteCommandResult(
  params: unknown,
): Promise<{ status: string; result?: RemoteJsonValue; errorCode?: string }> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("Remote result parameters are required.");
  }
  const record = params as Record<string, unknown>;
  if (
    !isIdentifier(record.ownerId) ||
    !isIdentifier(record.controllerDeviceId) ||
    !isEncryptedRemoteControlEnvelope(record.envelope) ||
    typeof record.command !== "object" ||
    record.command === null ||
    typeof record.targetIdentity !== "object" ||
    record.targetIdentity === null
  ) {
    throw new Error("Remote result authority is invalid.");
  }
  const envelope = record.envelope;
  if (envelope.messageKind !== "result") {
    throw new Error("Remote result envelope kind is invalid.");
  }
  const command = record.command as SignedRemoteCommand;
  const targetIdentity = record.targetIdentity as RemoteTargetPublicIdentity;
  const stored = await loadControllerIdentity(
    record.ownerId,
    record.controllerDeviceId,
  );
  if (!stored || stored.identity.keyId !== envelope.recipientKeyId) {
    throw new Error("Controller identity is unavailable or changed.");
  }
  const opened = openRemoteControlMessage(
    envelope,
    stored.encryptionPrivateKeyJwk,
    {
      ...command.body,
      messageKind: "result",
      senderKeyId: command.body.targetKeyId,
      recipientKeyId: command.body.controllerKeyId,
    },
  );
  // `openRemoteControlMessage` already validates the envelope's result kind;
  // retain that runtime proof while narrowing its intentionally-unioned return.
  const result = opened as SignedRemoteCommandResult;
  if (!verifyRemoteCommandResult(result, targetIdentity, command)) {
    throw new Error("Remote result signature or command binding is invalid.");
  }
  return {
    status: result.body.status,
    ...(result.body.result !== undefined ? { result: result.body.result } : {}),
    ...(result.body.errorCode ? { errorCode: result.body.errorCode } : {}),
  };
}

export async function desktopOpenRemoteCommandStartReceipt(
  params: unknown,
): Promise<{ startedAt: number; executionId: string }> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("Remote start receipt parameters are required.");
  }
  const record = params as Record<string, unknown>;
  if (
    !isIdentifier(record.ownerId) ||
    !isIdentifier(record.controllerDeviceId) ||
    !isEncryptedRemoteControlEnvelope(record.envelope) ||
    typeof record.command !== "object" ||
    record.command === null ||
    typeof record.targetIdentity !== "object" ||
    record.targetIdentity === null
  ) {
    throw new Error("Remote start receipt authority is invalid.");
  }
  const envelope = record.envelope;
  if (envelope.messageKind !== "start_receipt") {
    throw new Error("Remote start receipt envelope kind is invalid.");
  }
  const command = record.command as SignedRemoteCommand;
  const targetIdentity = record.targetIdentity as RemoteTargetPublicIdentity;
  const stored = await loadControllerIdentity(
    record.ownerId,
    record.controllerDeviceId,
  );
  if (!stored || stored.identity.keyId !== envelope.recipientKeyId) {
    throw new Error("Controller identity is unavailable or changed.");
  }
  const opened = openRemoteControlMessage(
    envelope,
    stored.encryptionPrivateKeyJwk,
    {
      ...command.body,
      messageKind: "start_receipt",
      senderKeyId: command.body.targetKeyId,
      recipientKeyId: command.body.controllerKeyId,
    },
  ) as SignedRemoteCommandStartReceipt;
  if (!verifyRemoteCommandStartReceipt(opened, targetIdentity, command)) {
    throw new Error(
      "Remote start receipt signature or command binding is invalid.",
    );
  }
  return {
    startedAt: opened.body.startedAt,
    executionId: opened.body.executionId,
  };
}

export const remoteControllerInternals = {
  controllerVaultId,
  identityKeyId,
  parseStoredIdentity,
};
