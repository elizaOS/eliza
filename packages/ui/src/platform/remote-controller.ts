/**
 * Renderer adapter for the native remote-controller identity. The native mobile
 * plugin retains private signing/decryption keys; this module only forwards
 * public identity, encrypted commands, and opaque result envelopes.
 */
import { Capacitor } from "@capacitor/core";
import {
  type EncryptedRemoteControlEnvelope,
  isEncryptedRemoteControlEnvelope,
  isRemoteControllerPublicIdentity,
  isSignedRemoteCommand,
  type RemoteCommandAction,
  type RemoteControllerPublicIdentity,
  type RemoteJsonValue,
  type RemoteTargetPublicIdentity,
  type SignedRemoteCommand,
} from "@elizaos/contracts";

interface NativeRemoteControllerPlugin {
  getOrCreateIdentity(input: {
    ownerId: string;
    displayName: string;
    platform: string;
  }): Promise<RemoteControllerPublicIdentity>;
  createCommand(input: Record<string, unknown>): Promise<unknown>;
  acknowledgeEnqueue(input: Record<string, unknown>): Promise<{
    acknowledged: boolean;
  }>;
  openResult(input: Record<string, unknown>): Promise<unknown>;
  openStartReceipt(input: Record<string, unknown>): Promise<unknown>;
  clearSessionState(input: Record<string, unknown>): Promise<{
    cleared: boolean;
  }>;
}
type NativeCommandResult = {
  commandId: string;
  expiresAt: number;
  command: SignedRemoteCommand;
  envelope: EncryptedRemoteControlEnvelope;
  recoveredPending: boolean;
  bindingDigest: string;
};
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNativeCommandResult(value: unknown): value is NativeCommandResult {
  return (
    isRecord(value) &&
    typeof value.commandId === "string" &&
    Number.isSafeInteger(value.expiresAt) &&
    isSignedRemoteCommand(value.command) &&
    isEncryptedRemoteControlEnvelope(value.envelope) &&
    typeof value.recoveredPending === "boolean" &&
    typeof value.bindingDigest === "string"
  );
}
function isOpenedResult(value: unknown): value is {
  status: string;
  result?: RemoteJsonValue;
  errorCode?: string;
} {
  return (
    isRecord(value) &&
    ["completed", "rejected", "cancelled", "execution_ambiguous"].includes(
      String(value.status),
    ) &&
    (value.errorCode === undefined || typeof value.errorCode === "string")
  );
}
function isOpenedStartReceipt(value: unknown): value is {
  startedAt: number;
  executionId: string;
} {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.startedAt) &&
    typeof value.executionId === "string"
  );
}
let cachedNativeRemoteController: NativeRemoteControllerPlugin | undefined;
function nativeRemoteController(): NativeRemoteControllerPlugin {
  cachedNativeRemoteController ??=
    Capacitor.registerPlugin<NativeRemoteControllerPlugin>(
      "RemoteControllerIdentity",
    );
  return cachedNativeRemoteController;
}
function isNativeController(): boolean {
  const platform = Capacitor.getPlatform();
  return (
    Capacitor.isNativePlatform() &&
    platform === "ios" &&
    Capacitor.isPluginAvailable?.("RemoteControllerIdentity") === true
  );
}
function isUnsupportedNativeIOS(): boolean {
  return (
    Capacitor.isNativePlatform() &&
    Capacitor.getPlatform() === "ios" &&
    Capacitor.isPluginAvailable?.("RemoteControllerIdentity") !== true
  );
}
export async function getOrCreateRemoteControllerIdentity(input: {
  ownerId: string;
  displayName?: string;
}): Promise<RemoteControllerPublicIdentity> {
  if (isUnsupportedNativeIOS()) {
    throw new Error(
      "Secure mobile pairing is unavailable until the native iOS plugin is installed.",
    );
  }
  if (isNativeController()) {
    const identity = await nativeRemoteController().getOrCreateIdentity({
      ownerId: input.ownerId,
      displayName: input.displayName ?? "My iPhone",
      platform: Capacitor.getPlatform(),
    });
    if (
      !isRemoteControllerPublicIdentity(identity) ||
      identity.ownerId !== input.ownerId ||
      identity.platform !== "ios"
    ) {
      throw new Error("Secure mobile pairing identity is unavailable.");
    }
    return identity;
  }
  throw new Error(
    "Secure remote control requires the native mobile controller.",
  );
}
export async function createRemoteCommand(input: {
  ownerId: string;
  grantId: string;
  grantRevision: number;
  sessionId: string;
  controller: RemoteControllerPublicIdentity;
  target: RemoteTargetPublicIdentity;
  action: RemoteCommandAction;
  payload: RemoteJsonValue;
}): Promise<{
  commandId: string;
  expiresAt: number;
  command: SignedRemoteCommand;
  envelope: EncryptedRemoteControlEnvelope;
  recoveredPending: boolean;
  bindingDigest: string;
}> {
  if (isUnsupportedNativeIOS()) {
    throw new Error(
      "Secure mobile command signing is unavailable until the native iOS plugin is installed.",
    );
  }
  if (isNativeController()) {
    const result = await nativeRemoteController().createCommand({
      ownerId: input.ownerId,
      grantId: input.grantId,
      grantRevision: input.grantRevision,
      sessionId: input.sessionId,
      controllerDeviceId: input.controller.deviceId,
      controllerKeyId: input.controller.keyId,
      targetRuntimeId: input.target.runtimeId,
      targetKeyId: input.target.keyId,
      targetEncryptionPublicKeyJwk: input.target.encryptionPublicKeyJwk,
      action: input.action,
      payload: input.payload,
    });
    if (!isNativeCommandResult(result))
      throw new Error("Secure mobile command signing is unavailable.");
    return result;
  }
  throw new Error(
    "Secure remote control requires the native mobile controller.",
  );
}
export async function acknowledgeRemoteCommandEnqueue(input: {
  ownerId: string;
  controllerDeviceId: string;
  sessionId: string;
  commandId: string;
  bindingDigest: string;
}): Promise<boolean> {
  if (isUnsupportedNativeIOS()) {
    throw new Error(
      "Secure mobile enqueue acknowledgement is unavailable until the native iOS plugin is installed.",
    );
  }
  if (isNativeController()) {
    const result = await nativeRemoteController().acknowledgeEnqueue(input);
    if (!isRecord(result) || typeof result.acknowledged !== "boolean") {
      throw new Error("Secure mobile enqueue acknowledgement is unavailable.");
    }
    return result.acknowledged;
  }
  throw new Error(
    "Secure remote control requires the native mobile controller.",
  );
}
export async function openRemoteCommandResult(input: {
  ownerId: string;
  controllerDeviceId: string;
  envelope: EncryptedRemoteControlEnvelope;
  command: SignedRemoteCommand;
  targetIdentity: RemoteTargetPublicIdentity;
}): Promise<{
  status: string;
  result?: RemoteJsonValue;
  errorCode?: string;
}> {
  if (isUnsupportedNativeIOS()) {
    throw new Error(
      "Secure mobile result decryption is unavailable until the native iOS plugin is installed.",
    );
  }
  if (isNativeController()) {
    const result = await nativeRemoteController().openResult(input);
    if (!isOpenedResult(result))
      throw new Error("Secure mobile result decryption is unavailable.");
    return result;
  }
  throw new Error(
    "Secure remote control requires the native mobile controller.",
  );
}
export async function openRemoteCommandStartReceipt(input: {
  ownerId: string;
  controllerDeviceId: string;
  envelope: EncryptedRemoteControlEnvelope;
  command: SignedRemoteCommand;
  targetIdentity: RemoteTargetPublicIdentity;
}): Promise<{
  startedAt: number;
  executionId: string;
}> {
  if (isUnsupportedNativeIOS()) {
    throw new Error(
      "Secure mobile start receipt verification is unavailable until the native iOS plugin is installed.",
    );
  }
  if (isNativeController()) {
    const result = await nativeRemoteController().openStartReceipt(input);
    if (!isOpenedStartReceipt(result))
      throw new Error(
        "Secure mobile start receipt verification is unavailable.",
      );
    return result;
  }
  throw new Error(
    "Secure remote control requires the native mobile controller.",
  );
}
export async function clearRemoteControllerSessionState(input: {
  ownerId: string;
  controllerDeviceId: string;
  sessionId: string;
}): Promise<boolean> {
  if (isUnsupportedNativeIOS()) {
    throw new Error(
      "Secure mobile session cleanup is unavailable until the native iOS plugin is installed.",
    );
  }
  if (isNativeController()) {
    const result = await nativeRemoteController().clearSessionState(input);
    if (!isRecord(result) || typeof result.cleared !== "boolean") {
      throw new Error("Secure mobile session cleanup is unavailable.");
    }
    return result.cleared;
  }
  return false;
}
