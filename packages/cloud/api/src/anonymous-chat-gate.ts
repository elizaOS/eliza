/**
 * Strongly ordered anonymous chat identity and quota cache.
 *
 * Each object owns one session's lifetime/hourly counters, idempotent leases,
 * and crash recovery. Provider admission stays storage-local; alarms mirror
 * recovery snapshots to Postgres asynchronously by monotonic revision.
 */

import { runWithDbCacheAsync } from "@/db/client";
import {
  type AnonymousChatGateCounterSnapshot,
  anonymousSessionsRepository,
} from "@/db/repositories/anonymous-sessions";
import { runWithCloudBindingsAsync } from "@/lib/runtime/cloud-bindings";
import type { AppEnv } from "@/types/cloud-worker-env";

interface ActiveLease {
  hourlyResetAtMs: number;
  phase: "leased" | "dispatched";
  expiresAtMs: number;
}

interface TerminalLease {
  requestId: string;
  outcome: "committed" | "refunded";
}

interface CounterSnapshot {
  sessionId: string;
  revision: number;
  messageCount: number;
  hourlyMessageCount: number;
  hourlyResetAtMs: number | null;
  lastMessageAtMs: number;
}

interface PendingSnapshot extends CounterSnapshot {
  retryAtMs: number;
}

interface ReadyLedger {
  status: "ready";
  sessionId: string;
  userId: string;
  messageCount: number;
  messagesLimit: number;
  hourlyMessageCount: number;
  hourlyResetAtMs: number | null;
  hourlyLimit: number;
  expiresAtMs: number;
  revision: number;
  blocked: boolean;
  lastMessageAtMs: number;
  activeLeases: Record<string, ActiveLease>;
  terminalLeases: TerminalLease[];
  pendingSnapshot: PendingSnapshot | null;
}

interface InvalidLedger {
  status: "invalid";
}

type GateLedger = ReadyLedger | InvalidLedger;

interface HydrateRequest {
  sessionId: string;
  userId: string;
  messageCount: number;
  messagesLimit: number;
  hourlyMessageCount: number;
  hourlyResetAtMs: number | null;
  hourlyLimit: number;
  expiresAtMs: number;
  revision: number;
  blocked: boolean;
}

interface LeaseRequest {
  requestId: string;
}

interface ModerationRequest {
  blocked: boolean;
}

const LEDGER_KEY = "ledger";
const HOUR_MS = 60 * 60 * 1_000;
const LEASE_DISPATCH_TIMEOUT_MS = 30_000;
const DISPATCH_SETTLEMENT_TIMEOUT_MS = 20 * 60_000;
const SNAPSHOT_RETRY_MS = 60_000;
const MAX_ACTIVE_LEASES = 256;
const MAX_TERMINAL_LEASES = 1_024;

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return nonNegativeInteger(value) && value > 0;
}

function finiteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validOptionalTimestamp(value: unknown): value is number | null {
  return value === null || finiteTimestamp(value);
}

function jsonError(message: string, status: 400 | 409 | 410 | 503): Response {
  return Response.json({ success: false, error: message }, { status });
}

function cloneLedger(ledger: ReadyLedger): ReadyLedger {
  return {
    ...ledger,
    activeLeases: Object.fromEntries(
      Object.entries(ledger.activeLeases).map(([requestId, lease]) => [
        requestId,
        { ...lease },
      ]),
    ),
    terminalLeases: ledger.terminalLeases.map((lease) => ({ ...lease })),
    pendingSnapshot: ledger.pendingSnapshot
      ? { ...ledger.pendingSnapshot }
      : null,
  };
}

function rememberTerminal(
  ledger: ReadyLedger,
  requestId: string,
  outcome: TerminalLease["outcome"],
): void {
  ledger.terminalLeases.push({ requestId, outcome });
  if (ledger.terminalLeases.length > MAX_TERMINAL_LEASES) {
    ledger.terminalLeases.splice(
      0,
      ledger.terminalLeases.length - MAX_TERMINAL_LEASES,
    );
  }
}

function terminalLease(
  ledger: ReadyLedger,
  requestId: string,
): TerminalLease | undefined {
  return ledger.terminalLeases.find(
    (terminal) => terminal.requestId === requestId,
  );
}

function rotateHourlyWindow(ledger: ReadyLedger, now: number): void {
  if (
    ledger.hourlyResetAtMs === null ||
    ledger.hourlyResetAtMs < now - HOUR_MS
  ) {
    ledger.hourlyMessageCount = 0;
    ledger.hourlyResetAtMs = now;
  }
}

function hourlyRetryAfterSeconds(
  hourlyResetAtMs: number,
  nowMs: number,
): number {
  return Math.max(1, Math.ceil((hourlyResetAtMs + HOUR_MS - nowMs) / 1_000));
}

function snapshot(ledger: CounterSnapshot): CounterSnapshot {
  return {
    sessionId: ledger.sessionId,
    revision: ledger.revision,
    messageCount: ledger.messageCount,
    hourlyMessageCount: ledger.hourlyMessageCount,
    hourlyResetAtMs: ledger.hourlyResetAtMs,
    lastMessageAtMs: ledger.lastMessageAtMs,
  };
}

function refreshPendingSnapshot(ledger: ReadyLedger): void {
  if (!ledger.pendingSnapshot) return;
  ledger.pendingSnapshot = {
    ...snapshot(ledger),
    retryAtMs: ledger.pendingSnapshot.retryAtMs,
  };
}

function contextResponse(ledger: ReadyLedger): Response {
  return Response.json({
    context: {
      sessionId: ledger.sessionId,
      userId: ledger.userId,
      messageCount: ledger.messageCount,
      messagesLimit: ledger.messagesLimit,
    },
    blocked: ledger.blocked,
  });
}

export class AnonymousChatGate {
  private readonly state: DurableObjectState;
  private readonly env: AppEnv["Bindings"];
  private ledger: GateLedger | undefined;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(state: DurableObjectState, env: AppEnv["Bindings"]) {
    this.state = state;
    this.env = env;
  }

  private async load(): Promise<GateLedger | undefined> {
    this.ledger ??= await this.state.storage.get<GateLedger>(LEDGER_KEY);
    return this.ledger;
  }

  private async save(ledger: GateLedger): Promise<void> {
    const stored =
      ledger.status === "ready"
        ? cloneLedger(ledger)
        : ({ ...ledger } as const);
    const nextAlarmAt =
      stored.status === "ready"
        ? Math.min(
            ...Object.values(stored.activeLeases).map(
              (lease) => lease.expiresAtMs,
            ),
            ...(stored.pendingSnapshot
              ? [stored.pendingSnapshot.retryAtMs]
              : []),
          )
        : Number.POSITIVE_INFINITY;
    await this.state.storage.transaction(async (transaction) => {
      await transaction.put(LEDGER_KEY, stored);
      if (Number.isFinite(nextAlarmAt)) {
        await transaction.setAlarm(Math.max(Date.now() + 1_000, nextAlarmAt));
      } else {
        await transaction.deleteAlarm();
      }
    });
    this.ledger = stored;
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release: () => void = () => undefined;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async requireReady(): Promise<
    { ledger: ReadyLedger } | { response: Response }
  > {
    const ledger = await this.load();
    if (!ledger) {
      return {
        response: Response.json(
          {
            success: false,
            code: "anonymous_chat_gate_uninitialized",
            error: "Anonymous chat gate is warming",
          },
          { status: 503 },
        ),
      };
    }
    if (ledger.status === "invalid") {
      return {
        response: jsonError("Anonymous chat session is no longer active", 410),
      };
    }
    if (ledger.expiresAtMs <= Date.now()) {
      await this.save({ status: "invalid" });
      return {
        response: jsonError("Anonymous chat session has expired", 410),
      };
    }
    return { ledger };
  }

  private async hydrate(request: HydrateRequest): Promise<Response> {
    if (
      !validId(request.sessionId) ||
      !validId(request.userId) ||
      !nonNegativeInteger(request.messageCount) ||
      !positiveInteger(request.messagesLimit) ||
      !nonNegativeInteger(request.hourlyMessageCount) ||
      !validOptionalTimestamp(request.hourlyResetAtMs) ||
      !positiveInteger(request.hourlyLimit) ||
      !finiteTimestamp(request.expiresAtMs) ||
      !nonNegativeInteger(request.revision) ||
      typeof request.blocked !== "boolean"
    ) {
      return jsonError("Invalid anonymous chat hydration", 400);
    }

    const existing = await this.load();
    if (existing) {
      return Response.json({ hydrated: true, initialized: false });
    }
    await this.save({
      status: "ready",
      sessionId: request.sessionId,
      userId: request.userId,
      messageCount: request.messageCount,
      messagesLimit: request.messagesLimit,
      hourlyMessageCount: request.hourlyMessageCount,
      hourlyResetAtMs: request.hourlyResetAtMs,
      hourlyLimit: request.hourlyLimit,
      expiresAtMs: request.expiresAtMs,
      revision: request.revision,
      blocked: request.blocked,
      lastMessageAtMs: Date.now(),
      activeLeases: {},
      terminalLeases: [],
      pendingSnapshot: null,
    });
    return Response.json({ hydrated: true, initialized: true });
  }

  private async context(): Promise<Response> {
    const ready = await this.requireReady();
    if ("response" in ready) return ready.response;
    return contextResponse(ready.ledger);
  }

  private async lease(request: LeaseRequest): Promise<Response> {
    if (!validId(request.requestId)) {
      return jsonError("Invalid anonymous chat lease", 400);
    }
    const ready = await this.requireReady();
    if ("response" in ready) return ready.response;
    const ledger = cloneLedger(ready.ledger);

    const existing = ledger.activeLeases[request.requestId];
    if (existing) {
      return Response.json({
        admitted: true,
        duplicate: true,
        remaining: Math.max(0, ledger.messagesLimit - ledger.messageCount),
        limit: ledger.messagesLimit,
        snapshot: snapshot(ledger),
      });
    }
    if (terminalLease(ledger, request.requestId)) {
      return jsonError("Anonymous chat lease was already finalized", 409);
    }
    if (Object.keys(ledger.activeLeases).length >= MAX_ACTIVE_LEASES) {
      return jsonError("Anonymous chat gate capacity is exhausted", 503);
    }
    if (ledger.blocked) {
      return jsonError("Anonymous chat user is suspended", 410);
    }

    const now = Date.now();
    rotateHourlyWindow(ledger, now);
    if (ledger.messageCount >= ledger.messagesLimit) {
      return Response.json(
        {
          admitted: false,
          reason: "message_limit",
          remaining: 0,
          limit: ledger.messagesLimit,
        },
        { status: 429 },
      );
    }
    if (ledger.hourlyMessageCount >= ledger.hourlyLimit) {
      if (ledger.hourlyResetAtMs === null) {
        return jsonError("Anonymous chat hourly window is unavailable", 503);
      }
      const retryAfter = hourlyRetryAfterSeconds(ledger.hourlyResetAtMs, now);
      return Response.json(
        {
          admitted: false,
          reason: "hourly_limit",
          remaining: 0,
          limit: ledger.hourlyLimit,
          retryAfter,
        },
        {
          status: 429,
          headers: { "Retry-After": String(retryAfter) },
        },
      );
    }

    ledger.messageCount += 1;
    ledger.hourlyMessageCount += 1;
    ledger.revision += 1;
    ledger.lastMessageAtMs = now;
    refreshPendingSnapshot(ledger);
    if (ledger.hourlyResetAtMs === null) {
      return jsonError("Anonymous chat hourly window is unavailable", 503);
    }
    ledger.activeLeases[request.requestId] = {
      hourlyResetAtMs: ledger.hourlyResetAtMs,
      phase: "leased",
      expiresAtMs: now + LEASE_DISPATCH_TIMEOUT_MS,
    };
    await this.save(ledger);
    return Response.json({
      admitted: true,
      duplicate: false,
      remaining: Math.max(0, ledger.messagesLimit - ledger.messageCount),
      limit: ledger.messagesLimit,
      snapshot: snapshot(ledger),
    });
  }

  private async dispatch(request: LeaseRequest): Promise<Response> {
    if (!validId(request.requestId)) {
      return jsonError("Invalid anonymous chat dispatch", 400);
    }
    const ready = await this.requireReady();
    if ("response" in ready) return ready.response;
    const ledger = cloneLedger(ready.ledger);
    const terminal = terminalLease(ledger, request.requestId);
    if (terminal) {
      if (terminal.outcome !== "committed") {
        return jsonError("Anonymous chat lease was already refunded", 409);
      }
      return Response.json({ dispatched: true, duplicate: true });
    }
    const active = ledger.activeLeases[request.requestId];
    if (!active) {
      return jsonError("Anonymous chat lease was not found", 409);
    }
    const duplicate = active.phase === "dispatched";
    active.phase = "dispatched";
    active.expiresAtMs = Date.now() + DISPATCH_SETTLEMENT_TIMEOUT_MS;
    await this.save(ledger);
    return Response.json({ dispatched: true, duplicate });
  }

  private async refund(request: LeaseRequest): Promise<Response> {
    if (!validId(request.requestId)) {
      return jsonError("Invalid anonymous chat refund", 400);
    }
    const ready = await this.requireReady();
    if ("response" in ready) return ready.response;
    const ledger = cloneLedger(ready.ledger);
    const terminal = terminalLease(ledger, request.requestId);
    if (terminal) {
      if (terminal.outcome !== "refunded") {
        return jsonError("Anonymous chat lease was already committed", 409);
      }
      return Response.json({
        refunded: true,
        duplicate: true,
        snapshot: snapshot(ledger),
      });
    }

    const active = ledger.activeLeases[request.requestId];
    if (!active) {
      return jsonError("Anonymous chat lease was not found", 409);
    }
    const now = Date.now();
    rotateHourlyWindow(ledger, now);
    ledger.messageCount = Math.max(0, ledger.messageCount - 1);
    if (active.hourlyResetAtMs === ledger.hourlyResetAtMs) {
      ledger.hourlyMessageCount = Math.max(0, ledger.hourlyMessageCount - 1);
    }
    ledger.revision += 1;
    ledger.lastMessageAtMs = now;
    refreshPendingSnapshot(ledger);
    delete ledger.activeLeases[request.requestId];
    rememberTerminal(ledger, request.requestId, "refunded");
    await this.save(ledger);
    return Response.json({
      refunded: true,
      duplicate: false,
      snapshot: snapshot(ledger),
    });
  }

  private async commit(request: LeaseRequest): Promise<Response> {
    if (!validId(request.requestId)) {
      return jsonError("Invalid anonymous chat commit", 400);
    }
    const ready = await this.requireReady();
    if ("response" in ready) return ready.response;
    const ledger = cloneLedger(ready.ledger);
    const terminal = terminalLease(ledger, request.requestId);
    if (terminal) {
      if (terminal.outcome !== "committed") {
        return jsonError("Anonymous chat lease was already refunded", 409);
      }
      return Response.json({ committed: true, duplicate: true });
    }
    if (!ledger.activeLeases[request.requestId]) {
      return jsonError("Anonymous chat lease was not found", 409);
    }
    delete ledger.activeLeases[request.requestId];
    rememberTerminal(ledger, request.requestId, "committed");
    await this.save(ledger);
    return Response.json({ committed: true, duplicate: false });
  }

  private async moderation(request: ModerationRequest): Promise<Response> {
    if (typeof request.blocked !== "boolean") {
      return jsonError("Invalid anonymous chat moderation state", 400);
    }
    const ready = await this.requireReady();
    if ("response" in ready) return ready.response;
    const ledger = cloneLedger(ready.ledger);
    ledger.blocked = request.blocked;
    await this.save(ledger);
    return Response.json({ updated: true });
  }

  private async invalidate(): Promise<Response> {
    await this.save({ status: "invalid" });
    return Response.json({ invalidated: true });
  }

  private async claimAlarmWork(): Promise<CounterSnapshot | null> {
    const current = await this.load();
    if (!current || current.status === "invalid") return null;
    if (current.expiresAtMs <= Date.now()) {
      await this.save({ status: "invalid" });
      return null;
    }
    const ledger = cloneLedger(current);
    const now = Date.now();
    let refunded = false;
    for (const [requestId, lease] of Object.entries(ledger.activeLeases)) {
      if (lease.expiresAtMs > now) continue;
      delete ledger.activeLeases[requestId];
      if (lease.phase === "dispatched") {
        rememberTerminal(ledger, requestId, "committed");
        continue;
      }
      rotateHourlyWindow(ledger, now);
      ledger.messageCount = Math.max(0, ledger.messageCount - 1);
      if (lease.hourlyResetAtMs === ledger.hourlyResetAtMs) {
        ledger.hourlyMessageCount = Math.max(0, ledger.hourlyMessageCount - 1);
      }
      ledger.revision += 1;
      ledger.lastMessageAtMs = now;
      rememberTerminal(ledger, requestId, "refunded");
      refunded = true;
    }

    if (refunded) {
      ledger.pendingSnapshot = {
        ...snapshot(ledger),
        retryAtMs: now + SNAPSHOT_RETRY_MS,
      };
    }
    const persistence =
      ledger.pendingSnapshot &&
      (refunded || ledger.pendingSnapshot.retryAtMs <= now)
        ? snapshot(ledger.pendingSnapshot)
        : null;
    if (persistence && ledger.pendingSnapshot) {
      ledger.pendingSnapshot.retryAtMs = now + SNAPSHOT_RETRY_MS;
    }
    await this.save(ledger);
    return persistence;
  }

  private async clearPersistedSnapshot(revision: number): Promise<void> {
    const current = await this.load();
    if (
      !current ||
      current.status === "invalid" ||
      current.pendingSnapshot?.revision !== revision
    ) {
      return;
    }
    const ledger = cloneLedger(current);
    ledger.pendingSnapshot = null;
    await this.save(ledger);
  }

  private async persistSnapshot(snapshotValue: CounterSnapshot): Promise<void> {
    const dbSnapshot: AnonymousChatGateCounterSnapshot = {
      sessionId: snapshotValue.sessionId,
      revision: snapshotValue.revision,
      messageCount: snapshotValue.messageCount,
      hourlyMessageCount: snapshotValue.hourlyMessageCount,
      hourlyResetAt:
        snapshotValue.hourlyResetAtMs === null
          ? null
          : new Date(snapshotValue.hourlyResetAtMs),
      lastMessageAt: new Date(snapshotValue.lastMessageAtMs),
    };
    await runWithCloudBindingsAsync(this.env as Record<string, unknown>, () =>
      runWithDbCacheAsync(() =>
        anonymousSessionsRepository.persistGateCounterSnapshot(dbSnapshot),
      ),
    );
  }

  async alarm(): Promise<void> {
    const pending = await this.serialize(() => this.claimAlarmWork());
    if (!pending) return;
    await this.persistSnapshot(pending);
    await this.serialize(() => this.clearPersistedSnapshot(pending.revision));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      // error-policy:J3 malformed internal requests are rejected explicitly.
      return jsonError("Invalid JSON body", 400);
    }
    const path = new URL(request.url).pathname;
    if (path === "/context") {
      return await this.serialize(() => this.context());
    }
    if (path === "/hydrate") {
      return await this.serialize(() =>
        this.hydrate(body as unknown as HydrateRequest),
      );
    }
    if (path === "/lease") {
      return await this.serialize(() =>
        this.lease(body as unknown as LeaseRequest),
      );
    }
    if (path === "/dispatch") {
      return await this.serialize(() =>
        this.dispatch(body as unknown as LeaseRequest),
      );
    }
    if (path === "/refund") {
      return await this.serialize(() =>
        this.refund(body as unknown as LeaseRequest),
      );
    }
    if (path === "/commit") {
      return await this.serialize(() =>
        this.commit(body as unknown as LeaseRequest),
      );
    }
    if (path === "/moderation") {
      return await this.serialize(() =>
        this.moderation(body as unknown as ModerationRequest),
      );
    }
    if (path === "/invalidate") {
      return await this.serialize(() => this.invalidate());
    }
    return new Response("Not found", { status: 404 });
  }
}
