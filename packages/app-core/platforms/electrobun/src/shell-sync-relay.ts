/**
 * Main-process authority for the one desktop chat/voice controller. Renderer
 * windows never elect one another: this module owns the lease generation,
 * validates every snapshot and command at the native boundary, serializes
 * commands through the current owner, and retains terminal command outcomes for
 * idempotent redelivery. Renderer heartbeats are driven by native pings so a
 * hidden/throttled webview cannot accidentally create split-brain ownership.
 */
import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { logger } from "./logger";

import type { SendToWebview } from "./types";

export const SHELL_SYNC_PROTOCOL_VERSION = "3";
export const SHELL_AUTHORITY_STATE_MESSAGE = "shellControllerAuthorityState";
export const SHELL_AUTHORITY_COMMAND_MESSAGE =
  "shellControllerAuthorityCommand";
export const SHELL_AUTHORITY_DELIVERY_MESSAGE =
  "shellControllerAuthorityDelivery";
export const SHELL_AUTHORITY_PING_MESSAGE = "shellControllerAuthorityPing";

const PING_INTERVAL_MS = 2_000;
const ENDPOINT_TTL_MS = 10_000;
const COMMAND_TIMEOUT_MS = 15_000;
const COMMAND_OUTCOME_LIMIT = 1_024;
const MAX_TEXT_LENGTH = 1_000_000;
const MAX_IMAGE_DATA_LENGTH = 32_000_000;

type AuthorityRole = "owner" | "follower";
type AuthorityStatus =
  | "connected"
  | "connecting"
  | "disconnected"
  | "version-mismatch";

export interface ShellAuthorityState {
  endpointId: string;
  ownerEndpointId: string | null;
  generation: number;
  role: AuthorityRole;
  status: AuthorityStatus;
  snapshotSeq: number;
  snapshot: unknown | null;
}

export interface ShellAuthorityCommandResult {
  ok: boolean;
  error?: string;
}

export interface ShellAuthorityConnectParams {
  protocolVersion: string;
}

export interface ShellAuthorityPublishSnapshotParams {
  generation: number;
  snapshot: unknown;
}

export interface ShellAuthorityDispatchCommandParams {
  commandId: string;
  command: unknown;
}

export interface ShellAuthorityCompleteCommandParams {
  generation: number;
  commandId: string;
  fromEndpointId: string;
  ok: boolean;
  error?: string;
}

export interface ShellAuthorityDeliverParams {
  generation: number;
  targetEndpointId: string;
  delivery: unknown;
}

export interface ShellAuthorityCommandPush {
  generation: number;
  commandId: string;
  fromEndpointId: string;
  command: unknown;
}

export interface ShellAuthorityDeliveryPush {
  generation: number;
  delivery: unknown;
}

export interface ShellControllerEndpoint {
  connect(params: unknown): ShellAuthorityState;
  heartbeat(params: unknown): ShellAuthorityState;
  publishSnapshot(params: unknown): { ok: boolean };
  dispatchCommand(params: unknown): Promise<ShellAuthorityCommandResult>;
  completeCommand(params: unknown): { ok: boolean };
  deliver(params: unknown): { ok: boolean };
  release(): void;
}

interface EndpointRecord {
  id: string;
  label: string;
  priority: number;
  send: SendToWebview;
  connected: boolean;
  protocolVersion: string | null;
  lastPongAt: number;
  staleWarned: boolean;
}

interface PendingCommand {
  key: string;
  ownerEndpointId: string;
  generation: number;
  promise: Promise<ShellAuthorityCommandResult>;
  resolve: (result: ShellAuthorityCommandResult) => void;
  timeout: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function commandKey(fromEndpointId: string, commandId: string): string {
  return `${fromEndpointId}\u0000${commandId}`;
}

const NO_ARG_COMMANDS = new Set([
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

const OS_INTENT_TYPES = new Set([
  "open-chat",
  "send",
  "start-voice",
  "stop-voice",
  "start-transcription",
  "stop-transcription",
  "continue-conversation",
]);

const OS_INTENT_SOURCES = new Set([
  "ios-app-intent",
  "ios-app-intents",
  "ios-app-shortcuts",
  "ios-widget",
  "ios-control",
  "ios-live-activity",
  "siri",
  "macos-shortcuts",
  "macos-siri",
  "android-app-actions",
  "android-assist",
  "android-assistant-session",
  "android-static-shortcut",
  "android-quick-settings",
  "android-recognition-service",
  "android-ime",
  "android-widget",
  "android-share-sheet",
  "desktop-deep-link",
  "desktop-tray",
  "desktop-hotkey",
  "notification",
  "assistant-entry",
  "in-app",
]);

function isOsIntent(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.intentId, 1_024) ||
    typeof value.type !== "string" ||
    !OS_INTENT_TYPES.has(value.type) ||
    typeof value.source !== "string" ||
    !OS_INTENT_SOURCES.has(value.source) ||
    !(
      value.issuedAt === undefined ||
      (typeof value.issuedAt === "number" && Number.isFinite(value.issuedAt))
    )
  ) {
    return false;
  }
  if (value.type === "send") {
    return (
      typeof value.text === "string" &&
      value.text.length > 0 &&
      value.text.length <= MAX_TEXT_LENGTH &&
      (value.channelType === undefined ||
        value.channelType === "DM" ||
        value.channelType === "VOICE_DM") &&
      (value.images === undefined ||
        (Array.isArray(value.images) &&
          value.images.length <= 32 &&
          value.images.every(isImageAttachment))) &&
      (value.metadata === undefined || isRecord(value.metadata))
    );
  }
  if (value.type === "start-voice") {
    return value.mode === "converse" || value.mode === "dictate";
  }
  return true;
}

function isImageAttachment(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const thumbnail = value.thumbnail;
  return (
    typeof value.data === "string" &&
    value.data.length <= MAX_IMAGE_DATA_LENGTH &&
    isNonEmptyString(value.mimeType, 256) &&
    isNonEmptyString(value.name, 2_000) &&
    (value.transcriptId === undefined ||
      isNonEmptyString(value.transcriptId)) &&
    (thumbnail === undefined ||
      (isRecord(thumbnail) &&
        typeof thumbnail.data === "string" &&
        thumbnail.data.length <= MAX_IMAGE_DATA_LENGTH &&
        isNonEmptyString(thumbnail.mimeType, 256)))
  );
}

/** Strict command decoder at the renderer/native trust boundary. */
export function isShellControllerCommand(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (NO_ARG_COMMANDS.has(value.kind)) return true;
  switch (value.kind) {
    case "send":
      return (
        typeof value.text === "string" &&
        value.text.length <= MAX_TEXT_LENGTH &&
        (value.channelType === undefined ||
          value.channelType === "DM" ||
          value.channelType === "VOICE_DM") &&
        (value.images === undefined ||
          (Array.isArray(value.images) &&
            value.images.length <= 32 &&
            value.images.every(isImageAttachment))) &&
        (value.metadata === undefined || isRecord(value.metadata))
      );
    case "startRecording":
      return (
        value.intent === undefined ||
        value.intent === "converse" ||
        value.intent === "dictate" ||
        value.intent === "transcription"
      );
    case "speak":
      return (
        typeof value.text === "string" && value.text.length <= MAX_TEXT_LENGTH
      );
    case "setComposerHasDraft":
      return typeof value.hasDraft === "boolean";
    case "navConversation":
      return value.direction === "prev" || value.direction === "next";
    case "routeOsIntent":
      return (
        isOsIntent(value.intent) &&
        (value.deliveryPolicy === "execute" ||
          value.deliveryPolicy === "review-send")
      );
    default:
      return false;
  }
}

/** Validate the render-critical snapshot before the native process retains it. */
export function isShellControllerSnapshot(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const phase = value.phase;
  const waveformMode = value.waveformMode;
  const micPermission = value.micPermission;
  const nav = value.conversationNav;
  const model = value.modelStatus;
  return (
    (phase === "booting" ||
      phase === "needs-auth" ||
      phase === "idle" ||
      phase === "summoned" ||
      phase === "listening" ||
      phase === "processing" ||
      phase === "responding") &&
    typeof value.responding === "boolean" &&
    (value.turnStatus === null || isRecord(value.turnStatus)) &&
    Array.isArray(value.messages) &&
    value.messages.length <= 10_000 &&
    value.messages.every(
      (message) =>
        isRecord(message) &&
        isNonEmptyString(message.id) &&
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string" &&
        typeof message.createdAt === "number" &&
        Number.isFinite(message.createdAt),
    ) &&
    typeof value.canSend === "boolean" &&
    isRecord(model) &&
    typeof model.kind === "string" &&
    typeof model.blocksSend === "boolean" &&
    typeof value.recording === "boolean" &&
    (waveformMode === "idle" ||
      waveformMode === "listening" ||
      waveformMode === "responding") &&
    typeof value.isOpen === "boolean" &&
    typeof value.visionCapturing === "boolean" &&
    typeof value.transcript === "string" &&
    value.transcript.length <= MAX_TEXT_LENGTH &&
    typeof value.speaking === "boolean" &&
    typeof value.agentVoiceMuted === "boolean" &&
    typeof value.needsAudioUnlock === "boolean" &&
    typeof value.handsFree === "boolean" &&
    (micPermission === "granted" ||
      micPermission === "denied" ||
      micPermission === "prompt" ||
      micPermission === "unknown") &&
    typeof value.transcriptionMode === "boolean" &&
    isRecord(nav) &&
    typeof nav.hasPrev === "boolean" &&
    typeof nav.hasNext === "boolean" &&
    (nav.activeId === null || typeof nav.activeId === "string") &&
    Number.isInteger(nav.index)
  );
}

function priorityForLabel(label: string): number {
  if (label === "main") return 0;
  if (label === "chat-overlay") return 1;
  if (label === "surface") return 2;
  if (label === "tray-popover") return 3;
  return 4;
}

export class ShellControllerAuthority {
  private readonly endpoints = new Map<string, EndpointRecord>();
  private readonly outcomes = new Map<string, ShellAuthorityCommandResult>();
  private readonly pending = new Map<string, PendingCommand>();
  private ownerEndpointId: string | null = null;
  private generation = 0;
  private snapshotSeq = 0;
  private snapshot: unknown | null = null;
  private endpointCounter = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  register(label: string, send: SendToWebview): ShellControllerEndpoint {
    this.endpointCounter += 1;
    const id = `shell-${this.endpointCounter}`;
    const endpoint: EndpointRecord = {
      id,
      label,
      priority: priorityForLabel(label),
      send,
      connected: false,
      protocolVersion: null,
      lastPongAt: this.now(),
      staleWarned: false,
    };
    this.endpoints.set(id, endpoint);
    this.ensurePingTimer();

    return {
      connect: (params) => this.connect(endpoint, params),
      heartbeat: (params) => this.heartbeat(endpoint, params),
      publishSnapshot: (params) => this.publishSnapshot(endpoint, params),
      dispatchCommand: (params) => this.dispatchCommand(endpoint, params),
      completeCommand: (params) => this.completeCommand(endpoint, params),
      deliver: (params) => this.deliver(endpoint, params),
      release: () => this.release(id),
    };
  }

  private connect(
    endpoint: EndpointRecord,
    params: unknown,
  ): ShellAuthorityState {
    // Tray-popover RPC objects are reused if their native window is recreated.
    // A close releases the endpoint; a later renderer connection re-registers
    // the same bound endpoint before it can participate in ownership.
    if (!this.endpoints.has(endpoint.id)) {
      this.endpoints.set(endpoint.id, endpoint);
      this.ensurePingTimer();
    }
    const protocolVersion = isRecord(params) ? params.protocolVersion : null;
    endpoint.connected = true;
    endpoint.protocolVersion =
      typeof protocolVersion === "string" ? protocolVersion : null;
    endpoint.lastPongAt = this.now();
    this.recomputeOwner();
    return this.stateFor(endpoint);
  }

  private heartbeat(
    endpoint: EndpointRecord,
    params: unknown,
  ): ShellAuthorityState {
    if (
      endpoint.connected &&
      isRecord(params) &&
      params.protocolVersion === endpoint.protocolVersion
    ) {
      endpoint.lastPongAt = this.now();
      endpoint.staleWarned = false;
    }
    this.sweepExpiredEndpoints();
    return this.stateFor(endpoint);
  }

  private publishSnapshot(
    endpoint: EndpointRecord,
    params: unknown,
  ): { ok: boolean } {
    if (
      !this.isCurrentOwner(endpoint, params) ||
      !isRecord(params) ||
      !isShellControllerSnapshot(params.snapshot)
    ) {
      return { ok: false };
    }
    this.snapshot = params.snapshot;
    this.snapshotSeq += 1;
    this.pushStateToFollowers();
    return { ok: true };
  }

  private dispatchCommand(
    endpoint: EndpointRecord,
    params: unknown,
  ): Promise<ShellAuthorityCommandResult> {
    if (!endpoint.connected || !isRecord(params)) {
      return Promise.resolve({ ok: false, error: "endpoint-disconnected" });
    }
    const commandId = params.commandId;
    if (
      !isNonEmptyString(commandId, 1024) ||
      !isShellControllerCommand(params.command)
    ) {
      return Promise.resolve({ ok: false, error: "invalid-command" });
    }
    const key = commandKey(endpoint.id, commandId);
    const prior = this.outcomes.get(key);
    if (prior) return Promise.resolve(prior);
    const existing = this.pending.get(key);
    if (existing) return existing.promise;

    const owner = this.currentOwner();
    if (!owner) {
      return Promise.resolve({ ok: false, error: "owner-unavailable" });
    }
    if (owner.id === endpoint.id) {
      return Promise.resolve({ ok: false, error: "owner-must-apply-locally" });
    }

    let resolve!: (result: ShellAuthorityCommandResult) => void;
    const promise = new Promise<ShellAuthorityCommandResult>((done) => {
      resolve = done;
    });
    const timeout = setTimeout(() => {
      const live = this.pending.get(key);
      if (!live) return;
      this.pending.delete(key);
      const result = { ok: false, error: "owner-command-timeout" } as const;
      this.rememberOutcome(key, result);
      live.resolve(result);
    }, COMMAND_TIMEOUT_MS);
    this.pending.set(key, {
      key,
      ownerEndpointId: owner.id,
      generation: this.generation,
      promise,
      resolve,
      timeout,
    });
    owner.send(SHELL_AUTHORITY_COMMAND_MESSAGE, {
      generation: this.generation,
      commandId,
      fromEndpointId: endpoint.id,
      command: params.command,
    });
    return promise;
  }

  private completeCommand(
    endpoint: EndpointRecord,
    params: unknown,
  ): { ok: boolean } {
    if (!this.isCurrentOwner(endpoint, params) || !isRecord(params)) {
      return { ok: false };
    }
    const commandId = params.commandId;
    const fromEndpointId = params.fromEndpointId;
    if (
      !isNonEmptyString(commandId, 1024) ||
      !isNonEmptyString(fromEndpointId) ||
      typeof params.ok !== "boolean"
    ) {
      return { ok: false };
    }
    const key = commandKey(fromEndpointId, commandId);
    const pending = this.pending.get(key);
    if (
      !pending ||
      pending.ownerEndpointId !== endpoint.id ||
      pending.generation !== this.generation
    ) {
      return { ok: this.outcomes.has(key) };
    }
    const result: ShellAuthorityCommandResult = params.ok
      ? { ok: true }
      : {
          ok: false,
          error:
            typeof params.error === "string" && params.error
              ? truncateWellFormed(toWellFormedUnicode(params.error), 2_000)
              : "owner-command-failed",
        };
    this.rememberOutcome(key, result);
    clearTimeout(pending.timeout);
    this.pending.delete(key);
    pending.resolve(result);
    return { ok: true };
  }

  private deliver(endpoint: EndpointRecord, params: unknown): { ok: boolean } {
    if (!this.isCurrentOwner(endpoint, params) || !isRecord(params)) {
      return { ok: false };
    }
    const targetEndpointId = params.targetEndpointId;
    const delivery = params.delivery;
    if (
      !isNonEmptyString(targetEndpointId) ||
      !this.isValidDelivery(delivery)
    ) {
      return { ok: false };
    }
    const target = this.endpoints.get(targetEndpointId);
    if (!target?.connected) return { ok: false };
    target.send(SHELL_AUTHORITY_DELIVERY_MESSAGE, {
      generation: this.generation,
      delivery,
    });
    return { ok: true };
  }

  private isValidDelivery(value: unknown): boolean {
    if (!isRecord(value) || typeof value.kind !== "string") return false;
    if (value.kind === "dictation" || value.kind === "composer-prefill") {
      return (
        typeof value.text === "string" && value.text.length <= MAX_TEXT_LENGTH
      );
    }
    if (value.kind === "transcript-session") {
      return (
        Array.isArray(value.segments) &&
        value.segments.length <= 10_000 &&
        typeof value.startedAtMs === "number" &&
        Number.isFinite(value.startedAtMs) &&
        (value.audioWav === null || value.audioWav instanceof Uint8Array)
      );
    }
    return false;
  }

  private isCurrentOwner(endpoint: EndpointRecord, params: unknown): boolean {
    return (
      endpoint.connected &&
      endpoint.id === this.ownerEndpointId &&
      isRecord(params) &&
      params.generation === this.generation
    );
  }

  private currentOwner(): EndpointRecord | null {
    return this.ownerEndpointId
      ? (this.endpoints.get(this.ownerEndpointId) ?? null)
      : null;
  }

  private stateFor(endpoint: EndpointRecord): ShellAuthorityState {
    const compatible = endpoint.protocolVersion === SHELL_SYNC_PROTOCOL_VERSION;
    const role: AuthorityRole =
      compatible && endpoint.id === this.ownerEndpointId ? "owner" : "follower";
    let status: AuthorityStatus;
    if (!compatible) status = "version-mismatch";
    else if (role === "owner") status = "connected";
    else if (!this.ownerEndpointId) status = "disconnected";
    else status = this.snapshot ? "connected" : "connecting";
    return {
      endpointId: endpoint.id,
      ownerEndpointId: this.ownerEndpointId,
      generation: this.generation,
      role,
      status,
      snapshotSeq: this.snapshotSeq,
      snapshot: role === "follower" ? this.snapshot : null,
    };
  }

  private recomputeOwner(): void {
    const current = this.currentOwner();
    if (
      current?.connected &&
      current.protocolVersion === SHELL_SYNC_PROTOCOL_VERSION
    ) {
      return;
    }
    const next = [...this.endpoints.values()]
      .filter(
        (endpoint) =>
          endpoint.connected &&
          endpoint.protocolVersion === SHELL_SYNC_PROTOCOL_VERSION,
      )
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))[0];
    const nextOwnerId = next?.id ?? null;
    if (nextOwnerId === this.ownerEndpointId) return;
    this.rejectPendingForLostOwner();
    this.ownerEndpointId = nextOwnerId;
    this.generation += 1;
    this.snapshotSeq = 0;
    this.snapshot = null;
    this.pushStateToAll();
  }

  private rejectPendingForLostOwner(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      const result = { ok: false, error: "owner-changed" } as const;
      this.rememberOutcome(pending.key, result);
      pending.resolve(result);
    }
    this.pending.clear();
  }

  private rememberOutcome(
    commandId: string,
    result: ShellAuthorityCommandResult,
  ): void {
    this.outcomes.set(commandId, result);
    if (this.outcomes.size <= COMMAND_OUTCOME_LIMIT) return;
    const oldest = this.outcomes.keys().next().value;
    if (oldest !== undefined) this.outcomes.delete(oldest);
  }

  private pushStateToAll(): void {
    for (const endpoint of this.endpoints.values()) {
      if (endpoint.connected) {
        endpoint.send(SHELL_AUTHORITY_STATE_MESSAGE, this.stateFor(endpoint));
      }
    }
  }

  private pushStateToFollowers(): void {
    for (const endpoint of this.endpoints.values()) {
      if (endpoint.connected && endpoint.id !== this.ownerEndpointId) {
        endpoint.send(SHELL_AUTHORITY_STATE_MESSAGE, this.stateFor(endpoint));
      }
    }
  }

  private ensurePingTimer(): void {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      const now = this.now();
      for (const endpoint of this.endpoints.values()) {
        if (endpoint.connected) {
          endpoint.send(SHELL_AUTHORITY_PING_MESSAGE, {
            generation: this.generation,
            now,
          });
        }
      }
      this.sweepExpiredEndpoints();
    }, PING_INTERVAL_MS);
  }

  sweepExpiredEndpoints(): void {
    const now = this.now();
    for (const endpoint of this.endpoints.values()) {
      if (
        endpoint.connected &&
        !endpoint.staleWarned &&
        now - endpoint.lastPongAt > ENDPOINT_TTL_MS
      ) {
        endpoint.staleWarned = true;
        logger.warn(
          `[shell-controller-authority] renderer heartbeat stale: ${endpoint.label}; ownership remains fenced until native window close`,
        );
      }
    }
  }

  private release(endpointId: string): void {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) return;
    endpoint.connected = false;
    this.endpoints.delete(endpointId);
    this.recomputeOwner();
    if (this.endpoints.size === 0 && this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

const authority = new ShellControllerAuthority();

/** Register one BrowserView with the main-process controller authority. */
export function registerShellSyncEndpoint(
  label: string,
  send: SendToWebview,
): ShellControllerEndpoint {
  return authority.register(label, send);
}
