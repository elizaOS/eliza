/**
 * Wire contract for sharing ONE shell chat/voice engine across the desktop's
 * detached webviews. Each desktop window is an isolated renderer; left alone,
 * every window that mounts the app would instantiate its own `useShellController`
 * and open its own microphone, giving duplicated sessions and fighting audio
 * owners (#16442). This module defines the messages exchanged with the native
 * main-process authority so exactly one window owns the engine and the rest
 * render its state and forward typed commands.
 *
 * Nothing here is React-specific. Every connection carries `protocolVersion`
 * so an incompatible renderer degrades visibly, and every command carries a
 * stable `commandId` so the authority can retain its terminal outcome.
 */

import type { TranscriptSegment } from "@elizaos/shared/transcripts";
import type { ImageAttachment } from "../../../api/client-types-chat";
import type { OsIntent } from "../../../os-intent/contract";
import { decodeOsIntent } from "../../../os-intent/decode";

/**
 * Bumped only on a breaking change to the envelope/command/snapshot shapes.
 * The native authority rejects a renderer whose version differs rather than
 * trusting a field that may have moved.
 */
export const SHELL_SYNC_PROTOCOL_VERSION = "2";

export type ShellWindowRole = "owner" | "follower";

/** The command a follower asks the owner to run. Discriminated on `kind`; the
 *  owner switches exhaustively so a new command cannot be silently dropped. */
export type ShellControllerCommand =
  | { kind: "open" }
  | { kind: "close" }
  | {
      kind: "send";
      text: string;
      channelType?: "DM" | "VOICE_DM";
      /** Image attachments — serialisable (data URLs / ids). */
      images?: ImageAttachment[];
      metadata?: Record<string, unknown>;
    }
  | { kind: "captureVision" }
  | { kind: "toggleRecording" }
  | {
      kind: "startRecording";
      intent?: "converse" | "dictate" | "transcription";
    }
  | { kind: "stopRecording" }
  | { kind: "toggleHandsFree" }
  | { kind: "toggleTranscriptionMode" }
  | { kind: "stopTranscriptionAndMic" }
  | { kind: "recheckMicPermission" }
  | { kind: "speak"; text: string }
  | { kind: "stopSpeaking" }
  | { kind: "toggleAgentVoiceMute" }
  | { kind: "unlockAudio" }
  | { kind: "setComposerHasDraft"; hasDraft: boolean }
  | { kind: "clearConversation" }
  | { kind: "openSettings" }
  | { kind: "navigateHome" }
  | { kind: "stop" }
  | { kind: "navConversation"; direction: "prev" | "next" }
  | {
      kind: "routeOsIntent";
      intent: OsIntent;
      deliveryPolicy: "execute" | "review-send";
    };

export type ShellControllerCommandKind = ShellControllerCommand["kind"];

export interface ShellAuthorityState {
  endpointId: string;
  ownerEndpointId: string | null;
  generation: number;
  role: ShellWindowRole;
  status: "connected" | "connecting" | "disconnected" | "version-mismatch";
  snapshotSeq: number;
  snapshot: unknown | null;
}

export interface ShellAuthorityCommandRequest {
  generation: number;
  commandId: string;
  fromEndpointId: string;
  command: ShellControllerCommand;
}

export type ShellAuthorityDelivery =
  | { kind: "dictation"; text: string }
  | { kind: "composer-prefill"; text: string }
  | {
      kind: "transcript-session";
      segments: TranscriptSegment[];
      startedAtMs: number;
      audioWav: Uint8Array | null;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isImageAttachment(value: unknown): value is ImageAttachment {
  if (!isRecord(value)) return false;
  const thumbnail = value.thumbnail;
  return (
    typeof value.data === "string" &&
    value.data.length <= 32_000_000 &&
    typeof value.mimeType === "string" &&
    value.mimeType.length > 0 &&
    value.mimeType.length <= 256 &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    value.name.length <= 2_000 &&
    (value.transcriptId === undefined ||
      (typeof value.transcriptId === "string" &&
        value.transcriptId.length > 0)) &&
    (thumbnail === undefined ||
      (isRecord(thumbnail) &&
        typeof thumbnail.data === "string" &&
        thumbnail.data.length <= 32_000_000 &&
        typeof thumbnail.mimeType === "string" &&
        thumbnail.mimeType.length > 0 &&
        thumbnail.mimeType.length <= 256))
  );
}

const NO_ARG_COMMANDS: ReadonlySet<ShellControllerCommandKind> = new Set([
  "open",
  "close",
  "captureVision",
  "toggleRecording",
  "stopRecording",
  "toggleHandsFree",
  "toggleTranscriptionMode",
  "stopTranscriptionAndMic",
  "recheckMicPermission",
  "stopSpeaking",
  "toggleAgentVoiceMute",
  "unlockAudio",
  "clearConversation",
  "openSettings",
  "navigateHome",
  "stop",
]);

/** Deep decoder for commands received from the native authority. */
export function parseShellControllerCommand(
  value: unknown,
): ShellControllerCommand | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (NO_ARG_COMMANDS.has(value.kind as ShellControllerCommandKind)) {
    return { kind: value.kind } as ShellControllerCommand;
  }
  switch (value.kind) {
    case "send":
      if (
        typeof value.text !== "string" ||
        value.text.length > 1_000_000 ||
        !(
          value.channelType === undefined ||
          value.channelType === "DM" ||
          value.channelType === "VOICE_DM"
        ) ||
        !(
          value.images === undefined ||
          (Array.isArray(value.images) &&
            value.images.length <= 32 &&
            value.images.every(isImageAttachment))
        ) ||
        !(value.metadata === undefined || isRecord(value.metadata))
      ) {
        return null;
      }
      return {
        kind: "send",
        text: value.text,
        ...(value.channelType ? { channelType: value.channelType } : {}),
        ...(value.images ? { images: value.images } : {}),
        ...(value.metadata ? { metadata: value.metadata } : {}),
      };
    case "startRecording":
      return value.intent === undefined ||
        value.intent === "converse" ||
        value.intent === "dictate" ||
        value.intent === "transcription"
        ? (value as unknown as ShellControllerCommand)
        : null;
    case "speak":
      return typeof value.text === "string" && value.text.length <= 1_000_000
        ? { kind: "speak", text: value.text }
        : null;
    case "setComposerHasDraft":
      return typeof value.hasDraft === "boolean"
        ? { kind: "setComposerHasDraft", hasDraft: value.hasDraft }
        : null;
    case "navConversation":
      return value.direction === "prev" || value.direction === "next"
        ? { kind: "navConversation", direction: value.direction }
        : null;
    case "routeOsIntent": {
      const decoded = decodeOsIntent(value.intent);
      return decoded.ok &&
        (value.deliveryPolicy === "execute" ||
          value.deliveryPolicy === "review-send")
        ? {
            kind: "routeOsIntent",
            intent: decoded.intent,
            deliveryPolicy: value.deliveryPolicy,
          }
        : null;
    }
    default:
      return null;
  }
}

export function parseShellAuthorityState(
  value: unknown,
): ShellAuthorityState | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.endpointId !== "string" ||
    !(
      value.ownerEndpointId === null ||
      typeof value.ownerEndpointId === "string"
    ) ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 0 ||
    (value.role !== "owner" && value.role !== "follower") ||
    !(
      value.status === "connected" ||
      value.status === "connecting" ||
      value.status === "disconnected" ||
      value.status === "version-mismatch"
    ) ||
    !Number.isSafeInteger(value.snapshotSeq) ||
    (value.snapshotSeq as number) < 0 ||
    !("snapshot" in value)
  ) {
    return null;
  }
  return {
    endpointId: value.endpointId,
    ownerEndpointId: value.ownerEndpointId,
    generation: value.generation as number,
    role: value.role,
    status: value.status,
    snapshotSeq: value.snapshotSeq as number,
    snapshot: value.snapshot,
  };
}

export function parseShellAuthorityCommandRequest(
  value: unknown,
): ShellAuthorityCommandRequest | null {
  if (!isRecord(value)) return null;
  const command = parseShellControllerCommand(value.command);
  if (
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 0 ||
    typeof value.commandId !== "string" ||
    !value.commandId ||
    typeof value.fromEndpointId !== "string" ||
    !value.fromEndpointId ||
    !command
  ) {
    return null;
  }
  return {
    generation: value.generation as number,
    commandId: value.commandId,
    fromEndpointId: value.fromEndpointId,
    command,
  };
}

export function parseShellAuthorityDelivery(
  value: unknown,
): ShellAuthorityDelivery | null {
  if (!isRecord(value)) return null;
  if (value.kind === "dictation" || value.kind === "composer-prefill") {
    return typeof value.text === "string" && value.text.length <= 1_000_000
      ? { kind: value.kind, text: value.text }
      : null;
  }
  if (value.kind === "transcript-session") {
    if (
      !Array.isArray(value.segments) ||
      value.segments.length > 10_000 ||
      !value.segments.every(
        (segment) =>
          isRecord(segment) &&
          typeof segment.id === "string" &&
          typeof segment.text === "string" &&
          typeof segment.startMs === "number" &&
          Number.isFinite(segment.startMs) &&
          typeof segment.endMs === "number" &&
          Number.isFinite(segment.endMs) &&
          Array.isArray(segment.words),
      ) ||
      typeof value.startedAtMs !== "number" ||
      !Number.isFinite(value.startedAtMs) ||
      !(value.audioWav === null || value.audioWav instanceof Uint8Array)
    ) {
      return null;
    }
    return value as unknown as ShellAuthorityDelivery;
  }
  return null;
}
