/**
 * Wire contract for sharing ONE shell chat/voice engine across the desktop's
 * detached webviews. Each desktop window is an isolated renderer; left alone,
 * every window that mounts the app would instantiate its own `useShellController`
 * and open its own microphone, giving duplicated sessions and fighting audio
 * owners (#16442). This module defines the messages those windows exchange over
 * a relay so exactly one window owns the engine and the rest render its state
 * and forward typed commands.
 *
 * Nothing here is React- or Electrobun-specific: the coordinator state machine
 * (`coordinator.ts`) and the transports (`transport.ts`, `electrobun-transport.ts`)
 * build on these types. Every envelope carries `protocolVersion` so a window
 * running an incompatible build degrades visibly instead of mis-rendering a
 * snapshot it cannot interpret, and every command carries a stable `commandId`
 * so the owner can apply it exactly once even if the relay redelivers it.
 */
import type { ImageAttachment } from "../../../api/client-types-chat";
import type { ShellControllerSnapshot } from "./snapshot";

/**
 * Bumped only on a breaking change to the envelope/command/snapshot shapes.
 * Receivers reject any envelope whose version differs (see
 * `isProtocolCompatible`) rather than trusting a field that may have moved.
 */
export const SHELL_SYNC_PROTOCOL_VERSION = "1";

/**
 * Relative preference for owning the engine, lower wins. The main dashboard
 * window is the natural home for capture + audio; the always-on bottom bar is
 * next; ephemeral popovers/detached surfaces should never win over a real
 * window that is already present. Ties break on the stable window id.
 */
export const SHELL_OWNER_PRIORITY = {
  main: 0,
  "chat-overlay": 1,
  surface: 2,
  "tray-popover": 3,
} as const;

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
  | { kind: "startRecording"; intent?: "converse" | "dictate" | "transcription" }
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
  | { kind: "navConversation"; direction: "prev" | "next" };

export type ShellControllerCommandKind = ShellControllerCommand["kind"];

/** Owner heartbeat + join/leave presence, feeding the liveness table that
 *  drives owner election. Both owner and followers announce. */
export interface ShellPresenceEnvelope {
  type: "presence";
  protocolVersion: string;
  event: "announce" | "bye";
  windowId: string;
  /** One of {@link SHELL_OWNER_PRIORITY}; lower is preferred as owner. */
  priority: number;
}

/** Owner → followers. `seq` is monotonic within an `epoch`; a new owner starts a
 *  new (higher) epoch so followers can drop snapshots from a superseded owner. */
export interface ShellSnapshotEnvelope {
  type: "snapshot";
  protocolVersion: string;
  ownerWindowId: string;
  epoch: number;
  seq: number;
  snapshot: ShellControllerSnapshot;
  /** When set, a targeted re-publish to one late joiner rather than a broadcast;
   *  other windows ignore it so a rejoin does not reset everyone's seq. */
  targetWindowId?: string;
}

/** Follower → owner. `commandId` is the idempotency + correlation key. */
export interface ShellCommandEnvelope {
  type: "command";
  protocolVersion: string;
  commandId: string;
  fromWindowId: string;
  command: ShellControllerCommand;
}

/** Owner → the follower that sent `commandId`. `ok:false` carries the reason so
 *  the follower can surface a real failure instead of a silent no-op. */
export interface ShellCommandAckEnvelope {
  type: "ack";
  protocolVersion: string;
  commandId: string;
  toWindowId: string;
  ok: boolean;
  error?: string;
}

export type ShellSyncEnvelope =
  | ShellPresenceEnvelope
  | ShellSnapshotEnvelope
  | ShellCommandEnvelope
  | ShellCommandAckEnvelope;

/** True when a received envelope was produced by a compatible build. An
 *  incompatible peer is not trusted: the coordinator surfaces a version-mismatch
 *  degrade rather than rendering a snapshot whose fields it cannot rely on. */
export function isProtocolCompatible(protocolVersion: string): boolean {
  return protocolVersion === SHELL_SYNC_PROTOCOL_VERSION;
}

const ENVELOPE_TYPES: ReadonlySet<string> = new Set([
  "presence",
  "snapshot",
  "command",
  "ack",
]);

/**
 * Validate an envelope arriving over the IPC boundary. The relay hands us
 * `unknown`; a malformed payload is rejected (returns null) rather than fed into
 * the state machine as a partly-typed object. The check is structural and
 * shallow — enough to route by `type` and to know the sender's protocol version;
 * the coordinator does the version gating and the payload is only trusted once
 * its version matches this build.
 */
export function parseShellSyncEnvelope(value: unknown): ShellSyncEnvelope | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const type = record.type;
  const protocolVersion = record.protocolVersion;
  if (typeof type !== "string" || !ENVELOPE_TYPES.has(type)) return null;
  if (typeof protocolVersion !== "string") return null;
  switch (type) {
    case "presence":
      return typeof record.windowId === "string" &&
        typeof record.priority === "number" &&
        (record.event === "announce" || record.event === "bye")
        ? (value as ShellSyncEnvelope)
        : null;
    case "snapshot":
      return typeof record.ownerWindowId === "string" &&
        typeof record.epoch === "number" &&
        typeof record.seq === "number" &&
        typeof record.snapshot === "object" &&
        record.snapshot !== null
        ? (value as ShellSyncEnvelope)
        : null;
    case "command":
      return typeof record.commandId === "string" &&
        typeof record.fromWindowId === "string" &&
        typeof record.command === "object" &&
        record.command !== null
        ? (value as ShellSyncEnvelope)
        : null;
    case "ack":
      return typeof record.commandId === "string" &&
        typeof record.toWindowId === "string" &&
        typeof record.ok === "boolean"
        ? (value as ShellSyncEnvelope)
        : null;
    default:
      return null;
  }
}

/** A live peer in the presence table. */
export interface ShellPeer {
  windowId: string;
  priority: number;
  /** The peer's protocol version. An incompatible peer STILL competes for
   *  ownership (so the compatible window does not spawn a second engine across
   *  the version boundary); a follower of an incompatible owner degrades to a
   *  visible version-mismatch state instead of rendering. */
  protocolVersion: string;
  /** `now()` value of the most recent announce; used to prune the dead. */
  lastSeenMs: number;
}

/**
 * Elect the owner deterministically from the live peer set: the lowest
 * `(priority, windowId)` wins. Pure and total — the same inputs always yield the
 * same owner on every window, so no two windows disagree about who owns the
 * engine. Returns `null` only for an empty set (a window always includes itself
 * before calling this).
 */
export function electOwnerWindowId(
  peers: ReadonlyArray<ShellPeer>,
): string | null {
  let best: ShellPeer | null = null;
  for (const peer of peers) {
    if (
      best === null ||
      peer.priority < best.priority ||
      (peer.priority === best.priority && peer.windowId < best.windowId)
    ) {
      best = peer;
    }
  }
  return best?.windowId ?? null;
}

/** Prune peers whose last announce is older than `ttlMs` — the mechanism that
 *  detects a crashed/closed owner (its heartbeats stop) and triggers
 *  re-election. Pure: returns the surviving subset. */
export function pruneStalePeers(
  peers: ReadonlyArray<ShellPeer>,
  nowMs: number,
  ttlMs: number,
): ShellPeer[] {
  return peers.filter((peer) => nowMs - peer.lastSeenMs <= ttlMs);
}

/**
 * Whether a snapshot at `(epoch, seq)` is newer than the last one applied at
 * `(appliedEpoch, appliedSeq)`. A relay may reorder or redeliver; a follower
 * applies a snapshot only when it strictly advances, so stale/duplicate
 * snapshots are dropped and a superseded owner (lower epoch) can never clobber
 * live state.
 */
export function isSnapshotNewer(
  incoming: { epoch: number; seq: number },
  applied: { epoch: number; seq: number } | null,
): boolean {
  if (applied === null) return true;
  if (incoming.epoch !== applied.epoch) return incoming.epoch > applied.epoch;
  return incoming.seq > applied.seq;
}
