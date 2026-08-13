/**
 * Per-organization serialized egress accounting and concurrency for the
 * HuggingFace proxy route.
 *
 * Cloudflare KV is eventually consistent and cannot safely increment a counter
 * under concurrency — the read/put loop in the route's original KV code lost
 * increments and let concurrent requests all read the same pre-update value. A
 * per-organization Durable Object atomically reserves egress and enforces a
 * concurrent-download cap. Every Worker request goes through a
 * reserve → stream → settle cycle:
 *
 *   1. `/reserve` — atomically checks the monthly egress budget and concurrent
 *      slot count. If both pass, a slot is held and the estimated bytes
 *      (content-length if known) are pre-charged. Returns the remaining budget
 *      and active download count.
 *   2. `/settle` — records the actual streamed byte count, adjusting the
 *      reserved estimate and releasing the concurrency slot.
 *   3. `/cancel` — releases the concurrency slot without charging (used when
 *      the Worker never reached upstream, e.g. a 4xx/5xx from HuggingFace).
 *
 * The Durable Object's single-threaded execution model makes every operation
 * serial for a given organization, so the reserve and settle steps are atomic
 * without any application-level locking. A best-effort operation queue
 * (mirrors `InferenceAdmissionGate`) keeps internal state consistent even when
 * Cloudflare co-schedules two requests into the same isolate.
 */

import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

/** Per-organization ledger of monthly egress and active downloads. */
interface HfProxyLedger {
  /** Latest month bucket admitted by this gate, e.g. "2026-08". */
  currentMonthBucket: string;
  /** Bytes consumed per month (reserved + actual settled). */
  monthUsedBytes: Record<string, number>;
  /** Number of active concurrent download slots. */
  activeDownloads: number;
  /** Active download slots keyed by requestId for cancellation/settlement. */
  slots: Record<string, HfProxySlot>;
  /** Recently terminal request IDs retained to make retries idempotent. */
  terminalRequestIds: string[];
}

interface HfProxySlot {
  requestId: string;
  /** Bytes reserved at /reserve time (content-length or 0 for chunked). */
  reservedBytes: number;
  monthBucket: string;
  lastHeartbeatAt: number;
}

interface ReserveRequest {
  requestId: string;
  /** Content-length if known from the upstream HEAD/initial response; else 0. */
  estimatedBytes: number;
  /** Monthly egress limit in bytes. */
  limitBytes: number;
  /** Max concurrent downloads per org. */
  maxConcurrent: number;
  /** Current month bucket key. */
  monthBucket: string;
}

interface SettleRequest {
  requestId: string;
  actualBytes: number;
  monthBucket: string;
}

interface CancelRequest {
  requestId: string;
  monthBucket: string;
}

interface HeartbeatRequest {
  requestId: string;
  monthBucket: string;
}

interface ReserveResponse {
  admitted: boolean;
  usedBytes: number;
  limitBytes: number;
  activeDownloads: number;
  maxConcurrent: number;
}

const LEDGER_KEY = "ledger";
const SLOT_LEASE_MS = 30 * 60_000;
const MAX_ACTIVE_DOWNLOADS_HARD = 256;
const MAX_TERMINAL_REQUEST_IDS = 2_048;

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function validMonthBucket(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function jsonError(message: string, status: 400 | 409 | 503): Response {
  return Response.json({ success: false, error: message }, { status });
}

function cloneLedger(ledger: HfProxyLedger): HfProxyLedger {
  const slots: Record<string, HfProxySlot> = {};
  for (const [key, slot] of Object.entries(ledger.slots)) {
    slots[key] = { ...slot };
  }
  return {
    currentMonthBucket: ledger.currentMonthBucket,
    monthUsedBytes: { ...ledger.monthUsedBytes },
    activeDownloads: ledger.activeDownloads,
    slots,
    terminalRequestIds: [...ledger.terminalRequestIds],
  };
}

export class HfProxyGate {
  private readonly state: DurableObjectState;
  private ledger: HfProxyLedger | undefined;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(state: DurableObjectState, _env: AppEnv["Bindings"]) {
    this.state = state;
  }

  /**
   * Validate the cached ledger. Corrupt storage is an explicit failure: the
   * old KV code silently treated malformed JSON as zero usage, which could
   * reset an org's monthly counter to zero mid-month.
   */
  private async load(): Promise<HfProxyLedger | undefined> {
    this.ledger ??= await this.state.storage.get<HfProxyLedger>(LEDGER_KEY);
    if (this.ledger) {
      if (
        !validMonthBucket(this.ledger.currentMonthBucket) ||
        typeof this.ledger.monthUsedBytes !== "object" ||
        this.ledger.monthUsedBytes === null ||
        Object.entries(this.ledger.monthUsedBytes).some(
          ([bucket, usedBytes]) =>
            !validMonthBucket(bucket) ||
            !Number.isSafeInteger(usedBytes) ||
            usedBytes < 0,
        ) ||
        !Number.isSafeInteger(this.ledger.activeDownloads) ||
        this.ledger.activeDownloads < 0 ||
        this.ledger.activeDownloads > MAX_ACTIVE_DOWNLOADS_HARD ||
        typeof this.ledger.slots !== "object" ||
        this.ledger.slots === null ||
        !Array.isArray(this.ledger.terminalRequestIds) ||
        this.ledger.terminalRequestIds.length > MAX_TERMINAL_REQUEST_IDS ||
        this.ledger.terminalRequestIds.some(
          (requestId) => !validId(requestId),
        ) ||
        Object.values(this.ledger.slots).some(
          (slot) =>
            !validId(slot.requestId) ||
            !Number.isSafeInteger(slot.reservedBytes) ||
            slot.reservedBytes < 0 ||
            !validMonthBucket(slot.monthBucket) ||
            !Number.isSafeInteger(slot.lastHeartbeatAt) ||
            slot.lastHeartbeatAt < 0,
        ) ||
        this.ledger.activeDownloads !== Object.keys(this.ledger.slots).length
      ) {
        throw new Error("HF proxy egress ledger is corrupt");
      }
      return this.ledger;
    }
    return undefined;
  }

  private markTerminal(ledger: HfProxyLedger, requestId: string): void {
    ledger.terminalRequestIds.push(requestId);
    if (ledger.terminalRequestIds.length > MAX_TERMINAL_REQUEST_IDS) {
      ledger.terminalRequestIds.shift();
    }
  }

  private async save(ledger: HfProxyLedger): Promise<void> {
    const snapshot = cloneLedger(ledger);
    await this.state.storage.put(LEDGER_KEY, snapshot);
    this.ledger = snapshot;
    if (snapshot.activeDownloads === 0) {
      await this.state.storage.deleteAlarm();
      return;
    }
    const nextExpiration = Math.min(
      ...Object.values(snapshot.slots).map(
        (slot) => slot.lastHeartbeatAt + SLOT_LEASE_MS,
      ),
    );
    await this.state.storage.setAlarm(nextExpiration);
  }

  /** Serialize operations so internal state stays consistent under co-scheduling. */
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

  private gcExpiredSlots(ledger: HfProxyLedger): boolean {
    const now = Date.now();
    let changed = false;
    for (const [requestId, slot] of Object.entries(ledger.slots)) {
      if (now - slot.lastHeartbeatAt >= SLOT_LEASE_MS) {
        // A slot that exceeded the TTL never settled — release it without
        // adjusting the byte counter (the actual bytes are unknown).
        delete ledger.slots[requestId];
        ledger.activeDownloads = Math.max(0, ledger.activeDownloads - 1);
        this.markTerminal(ledger, requestId);
        changed = true;
      }
    }
    return changed;
  }

  private async reserve(request: ReserveRequest): Promise<Response> {
    if (
      !validId(request.requestId) ||
      !Number.isSafeInteger(request.estimatedBytes) ||
      request.estimatedBytes < 0 ||
      !Number.isSafeInteger(request.limitBytes) ||
      request.limitBytes <= 0 ||
      !Number.isSafeInteger(request.maxConcurrent) ||
      request.maxConcurrent <= 0 ||
      request.maxConcurrent > MAX_ACTIVE_DOWNLOADS_HARD ||
      !validMonthBucket(request.monthBucket)
    ) {
      return jsonError("Invalid HF proxy reserve request", 400);
    }

    const loaded = await this.load();
    if (loaded && loaded.currentMonthBucket > request.monthBucket) {
      return jsonError("HF proxy reserve month is stale", 409);
    }
    const ledger = cloneLedger(
      loaded ?? {
        currentMonthBucket: request.monthBucket,
        monthUsedBytes: { [request.monthBucket]: 0 },
        activeDownloads: 0,
        slots: {},
        terminalRequestIds: [],
      },
    );
    if (request.monthBucket > ledger.currentMonthBucket) {
      ledger.currentMonthBucket = request.monthBucket;
      ledger.monthUsedBytes[request.monthBucket] = 0;
    }
    if (this.gcExpiredSlots(ledger)) {
      await this.save(ledger);
    }

    const usedBytes = ledger.monthUsedBytes[request.monthBucket] ?? 0;

    if (ledger.terminalRequestIds.includes(request.requestId)) {
      return jsonError("HF proxy reservation is already terminal", 409);
    }

    // Re-reserving an active request atomically adjusts its byte reservation.
    // The route uses this after upstream headers arrive and for each chunk when
    // Content-Length is unavailable.
    const existingSlot = ledger.slots[request.requestId];
    if (existingSlot) {
      const targetBytes = Math.max(
        existingSlot.reservedBytes,
        request.estimatedBytes,
      );
      if (existingSlot.monthBucket !== request.monthBucket) {
        return jsonError("HF proxy reservation month does not match", 409);
      }
      const projectedBytes =
        usedBytes - existingSlot.reservedBytes + targetBytes;
      if (
        !Number.isSafeInteger(projectedBytes) ||
        projectedBytes > request.limitBytes
      ) {
        return Response.json(
          {
            admitted: false,
            usedBytes,
            limitBytes: request.limitBytes,
            activeDownloads: ledger.activeDownloads,
            maxConcurrent: request.maxConcurrent,
          } satisfies ReserveResponse,
          { status: 429 },
        );
      }
      ledger.monthUsedBytes[request.monthBucket] = projectedBytes;
      existingSlot.reservedBytes = targetBytes;
      existingSlot.lastHeartbeatAt = Date.now();
      await this.save(ledger);
      return Response.json({
        admitted: true,
        usedBytes: projectedBytes,
        limitBytes: request.limitBytes,
        activeDownloads: ledger.activeDownloads,
        maxConcurrent: request.maxConcurrent,
      } satisfies ReserveResponse);
    }

    if (ledger.activeDownloads >= request.maxConcurrent) {
      return Response.json(
        {
          admitted: false,
          usedBytes,
          limitBytes: request.limitBytes,
          activeDownloads: ledger.activeDownloads,
          maxConcurrent: request.maxConcurrent,
        } satisfies ReserveResponse,
        { status: 429 },
      );
    }

    // Pre-charge the estimated bytes so concurrent requests see the update.
    const projectedBytes = usedBytes + request.estimatedBytes;
    if (
      !Number.isSafeInteger(projectedBytes) ||
      projectedBytes > request.limitBytes
    ) {
      return Response.json(
        {
          admitted: false,
          usedBytes,
          limitBytes: request.limitBytes,
          activeDownloads: ledger.activeDownloads,
          maxConcurrent: request.maxConcurrent,
        } satisfies ReserveResponse,
        { status: 429 },
      );
    }

    ledger.monthUsedBytes[request.monthBucket] = projectedBytes;
    ledger.activeDownloads += 1;
    ledger.slots[request.requestId] = {
      requestId: request.requestId,
      reservedBytes: request.estimatedBytes,
      monthBucket: request.monthBucket,
      lastHeartbeatAt: Date.now(),
    };
    await this.save(ledger);
    return Response.json({
      admitted: true,
      usedBytes: projectedBytes,
      limitBytes: request.limitBytes,
      activeDownloads: ledger.activeDownloads,
      maxConcurrent: request.maxConcurrent,
    } satisfies ReserveResponse);
  }

  private async settle(request: SettleRequest): Promise<Response> {
    if (
      !validId(request.requestId) ||
      !Number.isSafeInteger(request.actualBytes) ||
      request.actualBytes < 0 ||
      !validMonthBucket(request.monthBucket)
    ) {
      return jsonError("Invalid HF proxy settle request", 400);
    }

    const loaded = await this.load();
    if (!loaded) return jsonError("Unknown HF proxy reservation", 409);
    const ledger = cloneLedger(loaded);
    if (ledger.terminalRequestIds.includes(request.requestId)) {
      return Response.json({ settled: true });
    }
    const slot = ledger.slots[request.requestId];
    if (!slot) {
      return jsonError("Unknown HF proxy reservation", 409);
    }
    if (slot.monthBucket !== request.monthBucket) {
      return jsonError("HF proxy reservation month does not match", 409);
    }

    // Adjust: remove the pre-charge, add the actual.
    const usedBytes = ledger.monthUsedBytes[slot.monthBucket];
    if (usedBytes === undefined)
      throw new Error("HF proxy month ledger is missing");
    ledger.monthUsedBytes[slot.monthBucket] =
      Math.max(0, usedBytes - slot.reservedBytes) + request.actualBytes;
    delete ledger.slots[request.requestId];
    ledger.activeDownloads = Math.max(0, ledger.activeDownloads - 1);
    this.markTerminal(ledger, request.requestId);
    await this.save(ledger);
    return Response.json({ settled: true });
  }

  private async cancel(request: CancelRequest): Promise<Response> {
    if (!validId(request.requestId) || !validMonthBucket(request.monthBucket)) {
      return jsonError("Invalid HF proxy cancel request", 400);
    }

    const loaded = await this.load();
    if (!loaded) return jsonError("Unknown HF proxy reservation", 409);
    const ledger = cloneLedger(loaded);
    if (ledger.terminalRequestIds.includes(request.requestId)) {
      return Response.json({ cancelled: true });
    }
    const slot = ledger.slots[request.requestId];
    if (!slot) {
      return jsonError("Unknown HF proxy reservation", 409);
    }
    if (slot.monthBucket !== request.monthBucket) {
      return jsonError("HF proxy reservation month does not match", 409);
    }
    // Remove the pre-charge and release the slot.
    const usedBytes = ledger.monthUsedBytes[slot.monthBucket];
    if (usedBytes === undefined)
      throw new Error("HF proxy month ledger is missing");
    ledger.monthUsedBytes[slot.monthBucket] = Math.max(
      0,
      usedBytes - slot.reservedBytes,
    );
    delete ledger.slots[request.requestId];
    ledger.activeDownloads = Math.max(0, ledger.activeDownloads - 1);
    this.markTerminal(ledger, request.requestId);
    await this.save(ledger);
    return Response.json({ cancelled: true });
  }

  private async heartbeat(request: HeartbeatRequest): Promise<Response> {
    if (!validId(request.requestId) || !validMonthBucket(request.monthBucket)) {
      return jsonError("Invalid HF proxy heartbeat request", 400);
    }
    const loaded = await this.load();
    if (!loaded) return jsonError("Unknown HF proxy reservation", 409);
    const ledger = cloneLedger(loaded);
    if (ledger.terminalRequestIds.includes(request.requestId)) {
      return Response.json({ renewed: true });
    }
    const slot = ledger.slots[request.requestId];
    if (!slot) return jsonError("Unknown HF proxy reservation", 409);
    if (slot.monthBucket !== request.monthBucket) {
      return jsonError("HF proxy reservation month does not match", 409);
    }
    slot.lastHeartbeatAt = Date.now();
    await this.save(ledger);
    return Response.json({ renewed: true });
  }

  async alarm(): Promise<void> {
    await this.serialize(async () => {
      const loaded = await this.load();
      if (!loaded) return;
      const ledger = cloneLedger(loaded);
      this.gcExpiredSlots(ledger);
      await this.save(ledger);
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    let body: ReserveRequest | SettleRequest | CancelRequest | HeartbeatRequest;
    try {
      body = (await request.json()) as
        | ReserveRequest
        | SettleRequest
        | CancelRequest
        | HeartbeatRequest;
    } catch {
      // error-policy:J3 Request JSON is untrusted and invalid input is explicit.
      return jsonError("Invalid JSON body", 400);
    }
    if (!body) return jsonError("Invalid JSON body", 400);

    const path = new URL(request.url).pathname;
    try {
      if (path === "/reserve") {
        return await this.serialize(() => this.reserve(body as ReserveRequest));
      }
      if (path === "/settle") {
        return await this.serialize(() => this.settle(body as SettleRequest));
      }
      if (path === "/cancel") {
        return await this.serialize(() => this.cancel(body as CancelRequest));
      }
      if (path === "/heartbeat") {
        return await this.serialize(() =>
          this.heartbeat(body as HeartbeatRequest),
        );
      }
    } catch (error) {
      // error-policy:J1 The Durable Object boundary translates failures to 503.
      // Corrupt ledger or storage failure — fail closed so an org never gets
      // unmetered egress because the counter crashed.
      logger.error("[hf-proxy-gate] operation failed", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      return Response.json(
        {
          success: false,
          code: "hf_proxy_gate_error",
          error: "HF proxy gate operation failed",
        },
        { status: 503 },
      );
    }
    return new Response("Not found", { status: 404 });
  }
}
