/**
 * Durable end-to-end coordinator for Shared→Dedicated memory promotion
 * (round 3, #21090 review): open → fence → sealed export → staged delivery →
 * atomic finalize → promote, with abort-on-failure and crash resumability.
 *
 * Durability lives in the epoch row, not in this process: a coordinator that
 * dies after fencing leaves a `fenced` epoch; the next run RESUMES it —
 * fencing is idempotent to resume because the sealed export is a pure
 * function of the fenced scope. Any failure after fencing aborts the epoch
 * (lifting the write fence) and surfaces the typed error; staged rows on the
 * destination are drained by its TTL sweep. Nothing is ever half-promoted:
 * `promoted` is only recorded after the destination's atomic finalize
 * verifies the ORIGINAL seal.
 *
 * Egress is fail-closed: the destination host must be inside the private
 * CGNAT range (100.64.0.0/10) or match an explicitly configured suffix
 * (`ELIZA_MEMORY_TRANSFER_ALLOWED_HOST_SUFFIXES`); the check runs BEFORE any
 * request carries data.
 */
import { ElizaError } from "@elizaos/core";
import {
  type SealedExportSeal,
  type SealedMemoryExportRow,
  SHARED_MEMORY_TRANSFER_MAX_ROWS,
} from "@elizaos/shared/contracts/shared-memory-transfer";
import type { SharedAgentMemoryScope } from "../../../db/repositories/shared-agent-memories";
import {
  abortEpoch,
  fenceEpoch,
  getActiveEpoch,
  openEpoch,
  promoteEpoch,
} from "../../../db/repositories/shared-transfer-epochs";
import {
  appendReceipt,
  createOrResumeRecord,
  setRecordState,
} from "../../../db/repositories/shared-transfer-records";
import { exportSealedSharedMemories } from "./shared-memory-sealed-export";

export const SHARED_MEMORY_PROMOTION_TARGET_FORBIDDEN = "SHARED_MEMORY_PROMOTION_TARGET_FORBIDDEN";
export const SHARED_MEMORY_PROMOTION_DELIVERY_FAILED = "SHARED_MEMORY_PROMOTION_DELIVERY_FAILED";

const REQUEST_TIMEOUT_MS = 30_000;

export interface PromotionDestination {
  /** e.g. `http://100.64.12.3:7777` — validated against the allowlist. */
  baseUrl: string;
  headers?: Record<string, string>;
}

export interface PromotionResult {
  epoch: number;
  seal: SealedExportSeal;
  published: number;
  skipped_existing: number;
  resumed: boolean;
  /** Batch indexes skipped on resume because a stage receipt already existed. */
  skipped_batches: number[];
}

/** CGNAT 100.64.0.0/10 — second octet 64..127. */
function isCgnatHost(host: string): boolean {
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (!m) return false;
  const octet = Number(m[1]);
  return octet >= 64 && octet <= 127;
}

export function assertPromotionTargetAllowed(
  baseUrl: string,
  allowedSuffixesRaw: string | undefined = process.env.ELIZA_MEMORY_TRANSFER_ALLOWED_HOST_SUFFIXES,
): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ElizaError("Promotion destination is not a valid URL", {
      code: SHARED_MEMORY_PROMOTION_TARGET_FORBIDDEN,
    });
  }
  const host = url.hostname;
  if (isCgnatHost(host)) return url;
  const suffixes = (allowedSuffixesRaw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (suffixes.some((suffix) => host.toLowerCase().endsWith(suffix))) return url;
  throw new ElizaError("Promotion destination host is outside the transfer allowlist", {
    code: SHARED_MEMORY_PROMOTION_TARGET_FORBIDDEN,
    context: { host },
  });
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

async function postJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ElizaError("Promotion delivery request failed", {
      code: SHARED_MEMORY_PROMOTION_DELIVERY_FAILED,
      context: { url },
      cause: error,
    });
  }
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || payload.ok !== true) {
    throw new ElizaError("Promotion delivery was refused by the destination", {
      code: SHARED_MEMORY_PROMOTION_DELIVERY_FAILED,
      context: { url, status: response.status, error: payload.error ?? null },
    });
  }
  return payload;
}

/**
 * Run (or resume) one full promotion for the scope. Idempotent against
 * crashes: `open` and `fenced` epochs are picked up where they stand;
 * `promoted`/`aborted` epochs are terminal and a fresh epoch is opened.
 */
export async function runSealedPromotion(input: {
  scope: SharedAgentMemoryScope;
  destination: PromotionDestination;
  sealKey: string;
  fetchImpl?: FetchLike;
}): Promise<PromotionResult> {
  const { scope, destination, sealKey } = input;
  const fetchImpl = input.fetchImpl ?? (fetch as FetchLike);
  const target = assertPromotionTargetAllowed(destination.baseUrl);
  const headers = destination.headers ?? {};

  let active = await getActiveEpoch(scope);
  const resumed = active !== null;
  if (!active) active = await openEpoch(scope);
  if (active.state === "open") {
    active = await fenceEpoch(scope, active.epoch);
  }

  // Durable destination-bound record: created once per epoch, resumable only
  // against the SAME destination host; every delivery step leaves a receipt.
  const { record } = await createOrResumeRecord(scope, active.epoch, target.hostname);
  const ackedBatches = new Set(
    (record.receipts ?? []).filter((r) => r.kind === "stage").map((r) => Number(r.batch_index)),
  );

  try {
    const { seal, rows } = await exportSealedSharedMemories(scope, sealKey);
    const batches: SealedMemoryExportRow[][] = [];
    for (let i = 0; i < rows.length; i += SHARED_MEMORY_TRANSFER_MAX_ROWS) {
      batches.push(rows.slice(i, i + SHARED_MEMORY_TRANSFER_MAX_ROWS));
    }
    if (batches.length === 0) batches.push([]);
    const batchCount = Math.max(1, Math.ceil(seal.row_count / SHARED_MEMORY_TRANSFER_MAX_ROWS));
    await setRecordState(scope, active.epoch, "delivering", {
      sealDigest: seal.digest,
      batchCount,
    });
    const skippedBatches: number[] = [];
    for (const [index, batch] of batches.entries()) {
      if (ackedBatches.has(index)) {
        skippedBatches.push(index);
        continue;
      }
      const ack = await postJson(
        fetchImpl,
        new URL("/api/memory/transfer/stage", target).toString(),
        headers,
        { seal, batch_index: index, batch_count: batchCount, rows: batch },
      );
      await appendReceipt(scope, active.epoch, {
        kind: "stage",
        batch_index: index,
        total_staged: ack.total_staged ?? null,
        at: new Date().toISOString(),
      });
    }
    const finalized = await postJson(
      fetchImpl,
      new URL("/api/memory/transfer/finalize", target).toString(),
      headers,
      { seal },
    );
    const published = Number(finalized.published ?? 0);
    const skipped = Number(finalized.skipped_existing ?? 0);
    if (published + skipped !== seal.row_count) {
      throw new ElizaError("Destination finalize does not conserve the sealed row count", {
        code: SHARED_MEMORY_PROMOTION_DELIVERY_FAILED,
        context: { published, skipped, sealed: seal.row_count },
      });
    }
    await appendReceipt(scope, active.epoch, {
      kind: "finalize",
      published,
      skipped_existing: skipped,
      at: new Date().toISOString(),
    });
    await setRecordState(scope, active.epoch, "finalized");
    await promoteEpoch(scope, active.epoch, seal.digest);
    await setRecordState(scope, active.epoch, "promoted");
    return {
      epoch: active.epoch,
      seal,
      published,
      skipped_existing: skipped,
      resumed,
      skipped_batches: skippedBatches,
    };
  } catch (error) {
    await abortEpoch(scope, active.epoch).catch(() => {});
    await setRecordState(scope, active.epoch, "aborted").catch(() => {});
    throw error;
  }
}
