/**
 * Strongly ordered per-organization HuggingFace proxy egress quota ledger.
 *
 * Each object owns one org+month's committed byte total and the set of
 * in-flight reservations. Because a Durable Object is single-threaded,
 * all reservation, amendment, and commit operations are serialized — no
 * two isolates can reserve against the same stale remaining budget or
 * lose an increment in a read-modify-write race.
 *
 * The route accesses this object via
 * `env.HF_PROXY_EGRESS_GATES.getByName(orgId)`. If the binding is absent
 * (local dev without wrangler), the route falls back to the in-memory +
 * KV path, which is safe within a single isolate but not cross-isolate.
 */

import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const STORAGE_KEY = "egress-ledger";

interface GateLedger {
  /** Committed monthly egress total (bytes actually streamed). */
  committed: number;
  /** Month bucket, e.g. "2026-08" — so a month rollover resets the ledger. */
  monthBucket: string;
  /** In-flight reservations keyed by reservationId. */
  reservations: Record<string, { reserved: number }>;
}

function currentMonthBucket(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function emptyLedger(monthBucket: string): GateLedger {
  return { committed: 0, monthBucket, reservations: {} };
}

interface ReserveRequest {
  bytes: number;
  limitBytes: number;
}

interface ReserveResponse {
  admitted: boolean;
  reservationId: string | null;
  committed: number;
  inFlight: number;
}

interface AmendRequest {
  reservationId: string;
  actualBytes: number;
  limitBytes: number;
}

interface AmendResponse {
  ok: boolean;
  committed: number;
  inFlight: number;
}

interface CommitRequest {
  reservationId: string;
  bytes: number;
}

interface CommitResponse {
  committed: number;
}

interface ReleaseRequest {
  reservationId: string;
}

/**
 * One Durable Object instance per organization, owning the monthly egress
 * counter and in-flight reservations. All operations are serialized by the
 * single-threaded actor model — cross-isolate concurrency is impossible.
 */
export class HfProxyEgressGate {
  private readonly state: DurableObjectState;
  private ledger: GateLedger | undefined;

  constructor(state: DurableObjectState, _env: AppEnv["Bindings"]) {
    this.state = state;
  }

  private async load(): Promise<GateLedger> {
    if (this.ledger) {
      // Check for month rollover even on a cached ledger.
      const bucket = currentMonthBucket();
      if (this.ledger.monthBucket !== bucket) {
        this.ledger = emptyLedger(bucket);
      }
      return this.ledger;
    }
    const stored = await this.state.storage.get<GateLedger>(STORAGE_KEY);
    const bucket = currentMonthBucket();
    if (!stored || stored.monthBucket !== bucket) {
      this.ledger = emptyLedger(bucket);
    } else {
      this.ledger = stored;
    }
    return this.ledger;
  }

  private async save(): Promise<void> {
    if (this.ledger) {
      await this.state.storage.put(STORAGE_KEY, this.ledger);
    }
  }

  private inFlightBytes(ledger: GateLedger): number {
    let sum = 0;
    for (const res of Object.values(ledger.reservations)) {
      sum += res.reserved;
    }
    return sum;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const op = url.pathname;

    try {
      if (op === "/reserve") {
        const body = (await request.json()) as ReserveRequest;
        return Response.json(
          (await this.reserve(body)) satisfies ReserveResponse,
        );
      }
      if (op === "/amend") {
        const body = (await request.json()) as AmendRequest;
        return Response.json((await this.amend(body)) satisfies AmendResponse);
      }
      if (op === "/commit") {
        const body = (await request.json()) as CommitRequest;
        return Response.json(
          (await this.commit(body)) satisfies CommitResponse,
        );
      }
      if (op === "/release") {
        const body = (await request.json()) as ReleaseRequest;
        return Response.json(await this.release(body));
      }
      if (op === "/read") {
        const ledger = await this.load();
        return Response.json({
          committed: ledger.committed,
          inFlight: this.inFlightBytes(ledger),
        });
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[hf-proxy-egress-gate] operation failed", {
        operation: op,
        error: message,
      });
      return Response.json(
        { error: "HF_PROXY_EGRESS_GATE_ERROR", message },
        { status: 500 },
      );
    }
  }

  private async reserve(body: ReserveRequest): Promise<ReserveResponse> {
    const ledger = await this.load();
    const inFlight = this.inFlightBytes(ledger);
    const available = body.limitBytes - ledger.committed - inFlight;
    if (body.bytes > available) {
      return {
        admitted: false,
        reservationId: null,
        committed: ledger.committed,
        inFlight,
      };
    }
    const reservationId = crypto.randomUUID();
    ledger.reservations[reservationId] = { reserved: body.bytes };
    await this.save();
    return {
      admitted: true,
      reservationId,
      committed: ledger.committed,
      inFlight,
    };
  }

  private async amend(body: AmendRequest): Promise<AmendResponse> {
    const ledger = await this.load();
    const res = ledger.reservations[body.reservationId];
    if (!res) {
      return {
        ok: false,
        committed: ledger.committed,
        inFlight: this.inFlightBytes(ledger),
      };
    }
    if (body.actualBytes <= res.reserved) {
      // Shrink — always allowed, releases budget.
      res.reserved = body.actualBytes;
      await this.save();
      return {
        ok: true,
        committed: ledger.committed,
        inFlight: this.inFlightBytes(ledger),
      };
    }
    // Grow — re-check budget with this reservation temporarily zeroed.
    const oldReserved = res.reserved;
    res.reserved = 0;
    const inFlight = this.inFlightBytes(ledger);
    const available = body.limitBytes - ledger.committed - inFlight;
    if (body.actualBytes > available) {
      res.reserved = oldReserved;
      await this.save();
      return { ok: false, committed: ledger.committed, inFlight };
    }
    res.reserved = body.actualBytes;
    await this.save();
    return {
      ok: true,
      committed: ledger.committed,
      inFlight: this.inFlightBytes(ledger),
    };
  }

  private async commit(body: CommitRequest): Promise<CommitResponse> {
    const ledger = await this.load();
    // Idempotent: reservation already removed means a duplicate commit.
    if (!ledger.reservations[body.reservationId]) {
      return { committed: ledger.committed };
    }
    delete ledger.reservations[body.reservationId];
    if (body.bytes > 0) {
      ledger.committed += body.bytes;
    }
    await this.save();
    return { committed: ledger.committed };
  }

  private async release(body: ReleaseRequest): Promise<{ released: boolean }> {
    const ledger = await this.load();
    const existed = body.reservationId in ledger.reservations;
    delete ledger.reservations[body.reservationId];
    if (existed) await this.save();
    return { released: existed };
  }
}
