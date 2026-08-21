/**
 * Coordinates physical-host and isolated computer-use sessions. The manager
 * serializes each session, reserves the one real host cursor with a renewable
 * lease, and exposes virtual cursor/event state without retaining action input
 * text, credentials, screenshots, or other high-volume payloads.
 */

import { randomUUID } from "node:crypto";
import type {
  ComputerUseSessionAction,
  ComputerUseSessionActionResult,
  ComputerUseSessionEvent,
  ComputerUseSessionEventType,
  ComputerUseSessionExecutor,
  ComputerUseSessionFrame,
  ComputerUseSessionFrameProvider,
  ComputerUseSessionSnapshot,
  ComputerUseSessionTarget,
  ComputerUseVirtualCursor,
  CreateComputerUseSessionInput,
} from "./types.js";

const DEFAULT_HOST_LEASE_TTL_MS = 60_000;
const MIN_HOST_LEASE_TTL_MS = 5_000;
const MAX_HOST_LEASE_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_EVENTS = 256;
const MAX_LABEL_LENGTH = 120;
const MAX_ID_LENGTH = 128;
const MAX_COMMAND_LENGTH = 128;
const MAX_RECENT_ACTION_IDS = 128;
const SAFE_IDENTIFIER = /^[A-Za-z0-9._:-]+$/;
const ACTION_FAILURE_SUMMARY = "Computer-use action failed";
const FRAME_FAILURE_SUMMARY = "Computer-use frame capture failed";

export type ComputerUseSessionErrorCode =
  | "INVALID_SESSION_INPUT"
  | "SESSION_NOT_FOUND"
  | "SESSION_CLOSED"
  | "SESSION_BUSY"
  | "HOST_LEASE_CONFLICT"
  | "TARGET_LEASE_CONFLICT"
  | "HOST_LEASE_EXPIRED"
  | "STALE_SESSION_SEQUENCE"
  | "DUPLICATE_ACTION_ID";

export class ComputerUseSessionError extends Error {
  constructor(
    readonly code: ComputerUseSessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ComputerUseSessionError";
  }
}

interface MutableSession extends ComputerUseSessionSnapshot {
  recentActionIds: string[];
  recentActionIdSet: Set<string>;
}

interface ComputerUseSessionManagerOptions {
  executor: ComputerUseSessionExecutor;
  frameProvider?: ComputerUseSessionFrameProvider;
  now?: () => number;
  idFactory?: () => string;
  maxEvents?: number;
}

function timestamp(value: number): string {
  return new Date(value).toISOString();
}

function boundedLeaseTtl(value: number | undefined): number {
  if (value === undefined) return DEFAULT_HOST_LEASE_TTL_MS;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ComputerUseSessionError(
      "INVALID_SESSION_INPUT",
      "leaseTtlMs must be a positive integer",
    );
  }
  return Math.min(
    MAX_HOST_LEASE_TTL_MS,
    Math.max(MIN_HOST_LEASE_TTL_MS, value),
  );
}

function requireIdentifier(value: string | undefined, field: string): string {
  const normalized = value?.trim() ?? "";
  if (
    normalized.length === 0 ||
    normalized.length > MAX_ID_LENGTH ||
    !SAFE_IDENTIFIER.test(normalized)
  ) {
    throw new ComputerUseSessionError(
      "INVALID_SESSION_INPUT",
      `${field} must be 1-${MAX_ID_LENGTH} safe identifier characters`,
    );
  }
  return normalized;
}

function sanitizeViewerUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // error-policy:J3 untrusted session input; invalid viewer URLs are rejected.
    throw new ComputerUseSessionError(
      "INVALID_SESSION_INPUT",
      "viewerUrl must be an absolute http(s) URL",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ComputerUseSessionError(
      "INVALID_SESSION_INPUT",
      "viewerUrl must be an absolute http(s) URL",
    );
  }
  const hostname = parsed.hostname.toLowerCase();
  const loopback =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]";
  if (parsed.protocol === "http:" && !loopback) {
    throw new ComputerUseSessionError(
      "INVALID_SESSION_INPUT",
      "viewerUrl must use HTTPS unless it is loopback",
    );
  }
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function normalizeTarget(
  target: ComputerUseSessionTarget,
): ComputerUseSessionTarget {
  if (
    target.kind !== "host" &&
    target.kind !== "browser" &&
    target.kind !== "sandbox" &&
    target.kind !== "remote_guest"
  ) {
    throw new ComputerUseSessionError(
      "INVALID_SESSION_INPUT",
      "target.kind must be host, browser, sandbox, or remote_guest",
    );
  }
  if (target.kind === "host") {
    if (target.targetId !== undefined) {
      throw new ComputerUseSessionError(
        "INVALID_SESSION_INPUT",
        "host sessions must not provide targetId",
      );
    }
    return { kind: "host" };
  }
  return {
    kind: target.kind,
    targetId: requireIdentifier(target.targetId, "targetId"),
    ...(target.viewerUrl !== undefined
      ? { viewerUrl: sanitizeViewerUrl(target.viewerUrl) }
      : {}),
  };
}

function cloneCursor(
  cursor: ComputerUseVirtualCursor | undefined,
): ComputerUseVirtualCursor | undefined {
  return cursor ? { ...cursor } : undefined;
}

function cloneSnapshot(session: MutableSession): ComputerUseSessionSnapshot {
  const {
    recentActionIds: _ids,
    recentActionIdSet: _idSet,
    ...snapshot
  } = session;
  return {
    ...snapshot,
    target: { ...snapshot.target },
    cursor: cloneCursor(snapshot.cursor),
  };
}

function cursorFromAction(
  action: ComputerUseSessionAction,
  result: ComputerUseSessionActionResult,
  occurredAt: string,
): ComputerUseVirtualCursor | undefined {
  if (result.cursorPosition) {
    return {
      x: result.cursorPosition.x,
      y: result.cursorPosition.y,
      ...(typeof result.displayId === "number"
        ? { displayId: result.displayId }
        : {}),
      updatedAt: occurredAt,
    };
  }
  const parameters = action.parameters ?? {};
  const path = parameters.path;
  const pathEnd =
    Array.isArray(path) && path.length > 0 ? path[path.length - 1] : undefined;
  const coordinate = pathEnd ?? parameters.coordinate;
  if (
    Array.isArray(coordinate) &&
    coordinate.length === 2 &&
    typeof coordinate[0] === "number" &&
    Number.isFinite(coordinate[0]) &&
    typeof coordinate[1] === "number" &&
    Number.isFinite(coordinate[1])
  ) {
    return {
      x: coordinate[0],
      y: coordinate[1],
      ...(typeof parameters.displayId === "number"
        ? { displayId: parameters.displayId }
        : {}),
      updatedAt: occurredAt,
    };
  }
  return undefined;
}

export class ComputerUseSessionManager {
  private readonly executor: ComputerUseSessionExecutor;
  private readonly frameProvider?: ComputerUseSessionFrameProvider;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly maxEvents: number;
  private readonly sessions = new Map<string, MutableSession>();
  private readonly events: ComputerUseSessionEvent[] = [];
  private readonly listeners = new Set<
    (event: ComputerUseSessionEvent) => void
  >();
  private readonly targetOwners = new Map<string, string>();
  private hostSessionId: string | null = null;
  private nextEventId = 1;

  constructor(options: ComputerUseSessionManagerOptions) {
    this.executor = options.executor;
    this.frameProvider = options.frameProvider;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.maxEvents = Math.max(1, options.maxEvents ?? DEFAULT_MAX_EVENTS);
  }

  create(input: CreateComputerUseSessionInput): ComputerUseSessionSnapshot {
    const now = this.now();
    this.expireHostLease(now);
    const target = normalizeTarget(input.target);
    if (target.kind === "host" && this.hostSessionId !== null) {
      throw new ComputerUseSessionError(
        "HOST_LEASE_CONFLICT",
        `Physical host input is leased by session ${this.hostSessionId}`,
      );
    }
    const targetKey = this.targetKey(target);
    const targetOwner = this.targetOwners.get(targetKey);
    if (targetOwner) {
      throw new ComputerUseSessionError(
        "TARGET_LEASE_CONFLICT",
        `Computer-use target is leased by session ${targetOwner}`,
      );
    }
    const id = requireIdentifier(this.idFactory(), "session id");
    if (this.sessions.has(id)) {
      throw new ComputerUseSessionError(
        "INVALID_SESSION_INPUT",
        `Session id already exists: ${id}`,
      );
    }
    const label = input.label?.trim() || `${target.kind} session`;
    if (label.length > MAX_LABEL_LENGTH) {
      throw new ComputerUseSessionError(
        "INVALID_SESSION_INPUT",
        `label must be at most ${MAX_LABEL_LENGTH} characters`,
      );
    }
    const session: MutableSession = {
      id,
      label,
      target,
      status: "idle",
      sequence: 0,
      createdAt: timestamp(now),
      updatedAt: timestamp(now),
      ...(target.kind === "host"
        ? { leaseExpiresAt: timestamp(now + boundedLeaseTtl(input.leaseTtlMs)) }
        : {}),
      recentActionIds: [],
      recentActionIdSet: new Set(),
    };
    this.sessions.set(id, session);
    this.targetOwners.set(targetKey, id);
    if (target.kind === "host") this.hostSessionId = id;
    this.emit("session.created", session);
    return cloneSnapshot(session);
  }

  list(): ComputerUseSessionSnapshot[] {
    this.expireHostLease(this.now());
    return [...this.sessions.values()]
      .filter((session) => session.status !== "closed")
      .map(cloneSnapshot);
  }

  get(id: string): ComputerUseSessionSnapshot | null {
    this.expireHostLease(this.now());
    const session = this.sessions.get(id);
    return session ? cloneSnapshot(session) : null;
  }

  close(id: string): ComputerUseSessionSnapshot {
    const session = this.requireOpenSession(id);
    if (session.status === "running") {
      throw new ComputerUseSessionError(
        "SESSION_BUSY",
        `Session ${id} has an action in flight`,
      );
    }
    const now = this.now();
    session.status = "closed";
    session.updatedAt = timestamp(now);
    session.closedAt = timestamp(now);
    delete session.leaseExpiresAt;
    if (this.hostSessionId === id) this.hostSessionId = null;
    this.targetOwners.delete(this.targetKey(session.target));
    this.emit("session.closed", session);
    return cloneSnapshot(session);
  }

  renewHostLease(id: string, leaseTtlMs?: number): ComputerUseSessionSnapshot {
    const session = this.requireOpenSession(id);
    if (session.target.kind !== "host") {
      throw new ComputerUseSessionError(
        "INVALID_SESSION_INPUT",
        "Only host sessions have a physical-input lease",
      );
    }
    const now = this.now();
    if (!session.leaseExpiresAt || Date.parse(session.leaseExpiresAt) <= now) {
      this.expireHostLease(now);
      throw new ComputerUseSessionError(
        "HOST_LEASE_EXPIRED",
        `Host lease expired for session ${id}`,
      );
    }
    session.leaseExpiresAt = timestamp(now + boundedLeaseTtl(leaseTtlMs));
    session.updatedAt = timestamp(now);
    this.emit("session.lease_renewed", session);
    return cloneSnapshot(session);
  }

  async execute(
    id: string,
    action: ComputerUseSessionAction,
  ): Promise<{
    session: ComputerUseSessionSnapshot;
    result: ComputerUseSessionActionResult;
  }> {
    const session = this.requireOpenSession(id);
    this.assertAction(action);
    this.assertHostLeaseActive(session);
    if (session.status === "running") {
      throw new ComputerUseSessionError(
        "SESSION_BUSY",
        `Session ${id} has an action in flight`,
      );
    }
    if (action.expectedSequence !== session.sequence) {
      throw new ComputerUseSessionError(
        "STALE_SESSION_SEQUENCE",
        `Expected sequence ${action.expectedSequence}, current sequence is ${session.sequence}`,
      );
    }
    if (session.recentActionIdSet.has(action.actionId)) {
      throw new ComputerUseSessionError(
        "DUPLICATE_ACTION_ID",
        `Action id was already accepted: ${action.actionId}`,
      );
    }

    this.recordActionId(session, action.actionId);
    session.sequence += 1;
    session.status = "running";
    session.activeActionId = action.actionId;
    session.lastActionId = action.actionId;
    session.lastCommand = action.command;
    delete session.lastError;
    session.updatedAt = timestamp(this.now());
    this.emit("action.started", session, action);

    try {
      const result = await this.executor({ ...session.target }, action);
      const occurredAt = timestamp(this.now());
      const cursor = cursorFromAction(action, result, occurredAt);
      if (cursor) session.cursor = cursor;
      session.status = "idle";
      delete session.activeActionId;
      session.updatedAt = occurredAt;
      if (result.success) {
        this.emit("action.completed", session, action);
      } else {
        session.lastError = ACTION_FAILURE_SUMMARY;
        this.emit("action.failed", session, action, session.lastError);
      }
      this.expireHostLease(this.now());
      return { session: cloneSnapshot(session), result };
    } catch (error) {
      // error-policy:J1 action boundary — the manager records and rethrows the
      // typed/adapter failure so the route or planner can translate it once.
      session.status = "idle";
      delete session.activeActionId;
      session.lastError = ACTION_FAILURE_SUMMARY;
      session.updatedAt = timestamp(this.now());
      this.emit("action.failed", session, action, session.lastError);
      this.expireHostLease(this.now());
      throw error;
    }
  }

  async captureFrame(id: string): Promise<ComputerUseSessionFrame> {
    const session = this.requireOpenSession(id);
    this.assertHostLeaseActive(session);
    if (session.status === "running") {
      throw new ComputerUseSessionError(
        "SESSION_BUSY",
        `Session ${id} has an action in flight`,
      );
    }
    if (!this.frameProvider) {
      throw new ComputerUseSessionError(
        "INVALID_SESSION_INPUT",
        "No frame provider is configured",
      );
    }
    session.status = "running";
    session.updatedAt = timestamp(this.now());
    try {
      const frame = await this.frameProvider({ ...session.target });
      session.status = "idle";
      session.updatedAt = timestamp(this.now());
      this.expireHostLease(this.now());
      return { ...frame, capturedAt: session.updatedAt };
    } catch (error) {
      // error-policy:J1 observation boundary records the failure without
      // retaining frame bytes and rethrows for route translation.
      session.status = "idle";
      session.lastError = FRAME_FAILURE_SUMMARY;
      session.updatedAt = timestamp(this.now());
      this.expireHostLease(this.now());
      throw error;
    }
  }

  getEvents(afterEventId = 0): ComputerUseSessionEvent[] {
    return this.events
      .filter((event) => event.eventId > afterEventId)
      .map((event) => ({
        ...event,
        snapshot: {
          ...event.snapshot,
          target: { ...event.snapshot.target },
          cursor: cloneCursor(event.snapshot.cursor),
        },
      }));
  }

  subscribe(listener: (event: ComputerUseSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private requireOpenSession(id: string): MutableSession {
    this.expireHostLease(this.now());
    const session = this.sessions.get(id);
    if (!session) {
      throw new ComputerUseSessionError(
        "SESSION_NOT_FOUND",
        `Computer-use session was not found: ${id}`,
      );
    }
    if (session.status === "closed") {
      throw new ComputerUseSessionError(
        "SESSION_CLOSED",
        `Computer-use session is closed: ${id}`,
      );
    }
    return session;
  }

  private assertAction(action: ComputerUseSessionAction): void {
    requireIdentifier(action.actionId, "actionId");
    if (
      !Number.isSafeInteger(action.expectedSequence) ||
      action.expectedSequence < 0
    ) {
      throw new ComputerUseSessionError(
        "INVALID_SESSION_INPUT",
        "expectedSequence must be a non-negative integer",
      );
    }
    const command = action.command.trim();
    if (
      command.length === 0 ||
      command.length > MAX_COMMAND_LENGTH ||
      !SAFE_IDENTIFIER.test(command)
    ) {
      throw new ComputerUseSessionError(
        "INVALID_SESSION_INPUT",
        `command must be 1-${MAX_COMMAND_LENGTH} safe identifier characters`,
      );
    }
  }

  private assertHostLeaseActive(session: MutableSession): void {
    if (session.target.kind !== "host") return;
    const now = this.now();
    const leaseExpiresAt = session.leaseExpiresAt
      ? Date.parse(session.leaseExpiresAt)
      : 0;
    if (leaseExpiresAt > now) return;
    this.expireHostLease(now);
    throw new ComputerUseSessionError(
      "HOST_LEASE_EXPIRED",
      `Host lease expired for session ${session.id}`,
    );
  }

  private recordActionId(session: MutableSession, actionId: string): void {
    session.recentActionIds.push(actionId);
    session.recentActionIdSet.add(actionId);
    if (session.recentActionIds.length > MAX_RECENT_ACTION_IDS) {
      const removed = session.recentActionIds.shift();
      if (removed) session.recentActionIdSet.delete(removed);
    }
  }

  private expireHostLease(now: number): void {
    if (!this.hostSessionId) return;
    const session = this.sessions.get(this.hostSessionId);
    if (
      !session ||
      session.status === "closed" ||
      session.status === "running" ||
      !session.leaseExpiresAt ||
      Date.parse(session.leaseExpiresAt) > now
    ) {
      return;
    }
    session.status = "closed";
    session.updatedAt = timestamp(now);
    session.closedAt = timestamp(now);
    session.lastError = "Physical host input lease expired";
    delete session.leaseExpiresAt;
    delete session.activeActionId;
    this.hostSessionId = null;
    this.targetOwners.delete(this.targetKey(session.target));
    this.emit("session.closed", session, undefined, session.lastError);
  }

  private emit(
    type: ComputerUseSessionEventType,
    session: MutableSession,
    action?: ComputerUseSessionAction,
    error?: string,
  ): void {
    const event: ComputerUseSessionEvent = {
      eventId: this.nextEventId++,
      type,
      sessionId: session.id,
      sessionSequence: session.sequence,
      occurredAt: timestamp(this.now()),
      ...(action ? { actionId: action.actionId, command: action.command } : {}),
      ...(error ? { error } : {}),
      snapshot: cloneSnapshot(session),
    };
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    for (const listener of this.listeners) listener(event);
  }

  private targetKey(target: ComputerUseSessionTarget): string {
    return target.kind === "host"
      ? "host"
      : `${target.kind}:${target.targetId ?? ""}`;
  }
}
