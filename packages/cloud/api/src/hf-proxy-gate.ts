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
  /** Month bucket key this ledger covers, e.g. "2026-08". */
  monthBucket: string;
  /** Bytes consumed this month (reserved + actual settled). */
  usedBytes: number;
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
  startedAt: number;
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

interface ReserveResponse {
  admitted: boolean;
  usedBytes: number;
  limitBytes: number;
  activeDownloads: number;
  maxConcurrent: number;
}

const LEDGER_KEY = "ledger";
const SLOT_TTL_MS = 30 * 60_000;
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
    monthBucket: ledger.monthBucket,
    usedBytes: ledger.usedBytes,
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
  private async load(monthBucket: string): Promise<HfProxyLedger> {
    this.ledger ??= await this.state.storage.get<HfProxyLedger>(LEDGER_KEY);
    if (this.ledger) {
      if (
        !validMonthBucket(this.ledger.monthBucket) ||
        !Number.isSafeInteger(this.ledger.usedBytes) ||
        this.ledger.usedBytes < 0 ||
        !Number.isSafeInteger(this.ledger.activeDownloads) ||
        this.ledger.activeDownloads < 0 ||
        this.ledger.activeDownloads > MAX_ACTIVE_DOWNLOADS_HARD ||
        typeof this.ledger.slots !== "object" ||
        this.ledger.slots === null ||
        !Array.isArray(this.ledger.terminalRequestIds) ||
        this.ledger.terminalRequestIds.length > MAX_TERMINAL_REQUEST_IDS ||
        this.ledger.terminalRequestIds.some((requestId) => !validId(requestId))
      ) {
        throw new Error("HF proxy egress ledger is corrupt");
      }
      // Month rollover only moves forward. A late settle/cancel from the prior
      // month must never replace a newer ledger and erase its accounting.
      if (this.ledger.monthBucket < monthBucket) {
        return {
          monthBucket,
          usedBytes: 0,
          activeDownloads: 0,
          slots: {},
          terminalRequestIds: [],
        };
      }
      return this.ledger;
    }
    return {
      monthBucket,
      usedBytes: 0,
      activeDownloads: 0,
      slots: {},
      terminalRequestIds: [],
    };
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
      if (now - slot.startedAt > SLOT_TTL_MS) {
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

    const loaded = await this.load(request.monthBucket);
    if (loaded.monthBucket !== request.monthBucket) {
      return jsonError("HF proxy reserve month is stale", 409);
    }
    const ledger = cloneLedger(loaded);
    if (this.gcExpiredSlots(ledger)) {
      await this.save(ledger);
    }

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
      const projectedBytes =
        ledger.usedBytes - existingSlot.reservedBytes + targetBytes;
      if (
        !Number.isSafeInteger(projectedBytes) ||
        projectedBytes > request.limitBytes
      ) {
        return Response.json(
          {
            admitted: false,
            usedBytes: ledger.usedBytes,
            limitBytes: request.limitBytes,
            activeDownloads: ledger.activeDownloads,
            maxConcurrent: request.maxConcurrent,
          } satisfies ReserveResponse,
          { status: 429 },
        );
      }
      ledger.usedBytes = projectedBytes;
      existingSlot.reservedBytes = targetBytes;
      await this.save(ledger);
      return Response.json({
        admitted: true,
        usedBytes: ledger.usedBytes,
        limitBytes: request.limitBytes,
        activeDownloads: ledger.activeDownloads,
        maxConcurrent: request.maxConcurrent,
      } satisfies ReserveResponse);
    }

    if (ledger.activeDownloads >= request.maxConcurrent) {
      return Response.json(
        {
          admitted: false,
          usedBytes: ledger.usedBytes,
          limitBytes: request.limitBytes,
          activeDownloads: ledger.activeDownloads,
          maxConcurrent: request.maxConcurrent,
        } satisfies ReserveResponse,
        { status: 429 },
      );
    }

    // Pre-charge the estimated bytes so concurrent requests see the update.
    const projectedBytes = ledger.usedBytes + request.estimatedBytes;
    if (
      !Number.isSafeInteger(projectedBytes) ||
      projectedBytes > request.limitBytes
    ) {
      return Response.json(
        {
          admitted: false,
          usedBytes: ledger.usedBytes,
          limitBytes: request.limitBytes,
          activeDownloads: ledger.activeDownloads,
          maxConcurrent: request.maxConcurrent,
        } satisfies ReserveResponse,
        { status: 429 },
      );
    }

    ledger.usedBytes = projectedBytes;
    ledger.activeDownloads += 1;
    ledger.slots[request.requestId] = {
      requestId: request.requestId,
      reservedBytes: request.estimatedBytes,
      startedAt: Date.now(),
    };
    await this.save(ledger);
    return Response.json({
      admitted: true,
      usedBytes: ledger.usedBytes,
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

    const loaded = await this.load(request.monthBucket);
    if (loaded.monthBucket !== request.monthBucket) {
      return Response.json({ settled: true, stale: true });
    }
    const ledger = cloneLedger(loaded);
    if (ledger.terminalRequestIds.includes(request.requestId)) {
      return Response.json({ settled: true });
    }
    const slot = ledger.slots[request.requestId];
    if (!slot) {
      return jsonError("Unknown HF proxy reservation", 409);
    }

    // Adjust: remove the pre-charge, add the actual.
    ledger.usedBytes = Math.max(0, ledger.usedBytes - slot.reservedBytes);
    ledger.usedBytes += request.actualBytes;
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

    const loaded = await this.load(request.monthBucket);
    if (loaded.monthBucket !== request.monthBucket) {
      return Response.json({ cancelled: true, stale: true });
    }
    const ledger = cloneLedger(loaded);
    if (ledger.terminalRequestIds.includes(request.requestId)) {
      return Response.json({ cancelled: true });
    }
    const slot = ledger.slots[request.requestId];
    if (!slot) {
      return jsonError("Unknown HF proxy reservation", 409);
    }
    // Remove the pre-charge and release the slot.
    ledger.usedBytes = Math.max(0, ledger.usedBytes - slot.reservedBytes);
    delete ledger.slots[request.requestId];
    ledger.activeDownloads = Math.max(0, ledger.activeDownloads - 1);
    this.markTerminal(ledger, request.requestId);
    await this.save(ledger);
    return Response.json({ cancelled: true });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    let body: ReserveRequest | SettleRequest | CancelRequest;
    try {
      body = (await request.json()) as
        | ReserveRequest
        | SettleRequest
        | CancelRequest;
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

  async alarm(): Promise<void> {
    // GC expired slots so abandoned downloads don't permanently hold a
    // concurrency slot. This runs on the Durable Object's alarm schedule.
    const ledger =
      this.ledger ?? (await this.state.storage.get<HfProxyLedger>(LEDGER_KEY));
    if (!ledger) return;
    const snapshot = cloneLedger(ledger);
    this.gcExpiredSlots(snapshot);
    await this.state.storage.put(LEDGER_KEY, snapshot);
    this.ledger = snapshot;
  }
}
