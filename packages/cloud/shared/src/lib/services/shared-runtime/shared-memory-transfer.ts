/**
 * Sealed push of an exported Shared history into a Dedicated container —
 * the delivery leg of the Shared→Dedicated cutover, rebuilt to the #20923
 * containment contract.
 *
 * Egress discipline: the container base URL must pass an authority allowlist
 * BEFORE the agent's API token is attached (tailnet hosts by default —
 * headscale CGNAT addresses and configured domain suffixes; anything else is
 * a typed refusal), and every request carries a hard timeout. Response
 * discipline: a batch only counts when the importer answered `ok` with
 * `digest_verified` and the counts conserve (`imported + skipped_existing`
 * equals the batch size; embeddings conserve exactly on a fresh container).
 * Anything less is a typed failure — a partial transfer is re-runnable
 * against the idempotent importer, never silently reported complete.
 */

import { ElizaError } from "@elizaos/core";
import {
  computeSharedMemoryTransferDigest,
  type SealedImportResponse,
  SealedImportResponseSchema,
  type SealedMemoryExportRow,
  SHARED_MEMORY_TRANSFER_MAX_ROWS,
} from "@elizaos/shared/contracts/shared-memory-transfer";
import {
  exportSealedSharedMemories,
  type SealedExportAgent,
  type SealedMemoryExport,
} from "./shared-memory-sealed-export";

export const SHARED_MEMORY_TRANSFER_FAILED = "SHARED_MEMORY_TRANSFER_FAILED";
export const SHARED_MEMORY_TRANSFER_TARGET_REFUSED = "SHARED_MEMORY_TRANSFER_TARGET_REFUSED";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ALLOWED_HOST_SUFFIXES = [".eliza.local"];

/** Container ingress: tailnet-reachable base URL plus its ELIZA_API_TOKEN. */
export interface SharedMemoryTransferTarget {
  baseUrl: string;
  apiToken: string;
}

export interface SharedMemoryTransferResult {
  rows: number;
  batches: number;
  imported: number;
  skippedExisting: number;
  embeddingsWritten: number;
}

/** Headscale/Tailscale CGNAT range: 100.64.0.0/10. */
function isTailnetAddress(host: string): boolean {
  const match = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (!match) return false;
  const second = Number(match[1]);
  return second >= 64 && second <= 127;
}

function allowedHostSuffixes(): string[] {
  const raw = process.env.ELIZA_MEMORY_TRANSFER_ALLOWED_HOST_SUFFIXES;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return DEFAULT_ALLOWED_HOST_SUFFIXES;
  }
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.startsWith("."));
}

/**
 * The agent's API token may only travel to a container-shaped authority.
 * Exported for direct unit coverage.
 */
export function assertTransferTargetAllowed(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    // error-policy:J2 unparseable target becomes the typed refusal below
    throw new ElizaError("Memory transfer target URL is unparseable", {
      code: SHARED_MEMORY_TRANSFER_TARGET_REFUSED,
      context: { baseUrl },
    });
  }
  const host = url.hostname.toLowerCase();
  const allowed =
    isTailnetAddress(host) || allowedHostSuffixes().some((suffix) => host.endsWith(suffix));
  if (!allowed || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new ElizaError("Memory transfer target is outside the container authority allowlist", {
      code: SHARED_MEMORY_TRANSFER_TARGET_REFUSED,
      context: { host, protocol: url.protocol },
    });
  }
  return url;
}

function transferTimeoutMs(): number {
  const raw = process.env.ELIZA_MEMORY_TRANSFER_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 1_000 && parsed <= 300_000
    ? parsed
    : DEFAULT_TIMEOUT_MS;
}

function batchSeal(full: SealedMemoryExport["seal"], rows: readonly SealedMemoryExportRow[]) {
  return {
    row_count: rows.length,
    embedding_count: rows.filter((row) => row.embedding).length,
    digest: computeSharedMemoryTransferDigest(rows),
    source_agent_id: full.source_agent_id,
    organization_id: full.organization_id,
    user_id: full.user_id,
  };
}

function validateBatchResponse(
  response: SealedImportResponse,
  rows: readonly SealedMemoryExportRow[],
): void {
  const batchEmbeddings = rows.filter((row) => row.embedding).length;
  const conserves =
    response.ok === true &&
    response.digest_verified === true &&
    Array.isArray(response.conflicts) &&
    response.conflicts.length === 0 &&
    response.imported + response.skipped_existing === rows.length &&
    response.embeddings_written <= batchEmbeddings &&
    response.embeddings_written <= response.imported &&
    response.embeddings_skipped_verified <= response.skipped_existing &&
    response.embeddings_written + response.embeddings_skipped_verified === batchEmbeddings;
  if (!conserves) {
    throw new ElizaError("Dedicated container import response failed conservation validation", {
      code: SHARED_MEMORY_TRANSFER_FAILED,
      context: {
        imported: response.imported,
        skippedExisting: response.skipped_existing,
        embeddingsWritten: response.embeddings_written,
        embeddingsSkippedVerified: response.embeddings_skipped_verified,
        batchRows: rows.length,
        batchEmbeddings,
        ok: response.ok,
        digestVerified: response.digest_verified,
      },
    });
  }
}

async function postBatch(
  target: SharedMemoryTransferTarget,
  seal: ReturnType<typeof batchSeal>,
  rows: readonly SealedMemoryExportRow[],
  fetchImpl: typeof fetch,
): Promise<SealedImportResponse> {
  const base = assertTransferTargetAllowed(target.baseUrl);
  let response: Response;
  try {
    response = await fetchImpl(new URL("/api/memories/import", base).toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${target.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ seal, rows }),
      signal: AbortSignal.timeout(transferTimeoutMs()),
      // Memory payloads and bearer credentials must never be replayed to a
      // redirect-selected authority or path.
      redirect: "error",
    });
  } catch (cause) {
    // error-policy:J2 context-adding rethrow — provisioning must distinguish
    // retryable transfer transport failure from a completed promotion.
    throw new ElizaError("Dedicated container memory import transport failed", {
      code: SHARED_MEMORY_TRANSFER_FAILED,
      cause,
      context: { batchSize: rows.length },
      severity: "ephemeral",
    });
  }
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {
      // error-policy:J1 the status remains the authoritative transport error;
      // an unreadable optional response body must not replace it.
    }
    throw new ElizaError("Dedicated container rejected a memory import batch", {
      code: SHARED_MEMORY_TRANSFER_FAILED,
      context: { status: response.status, detail, batchSize: rows.length },
    });
  }
  let receipt: unknown;
  try {
    receipt = await response.json();
  } catch (cause) {
    // error-policy:J2 malformed transport data is a typed transfer failure.
    throw new ElizaError("Dedicated container returned unreadable import JSON", {
      code: SHARED_MEMORY_TRANSFER_FAILED,
      cause,
      context: { batchSize: rows.length },
    });
  }
  const parsed = SealedImportResponseSchema.safeParse(receipt);
  if (!parsed.success) {
    throw new ElizaError("Dedicated container returned an invalid import receipt", {
      code: SHARED_MEMORY_TRANSFER_FAILED,
      context: { issue: parsed.error.issues[0]?.message ?? "invalid receipt" },
    });
  }
  return parsed.data;
}

/**
 * Export the agent's Shared history under one sealed snapshot and push it to
 * the container in conservation-validated batches. Safe to re-run: replayed
 * rows come back as `skipped_existing`, and any failure is typed and total.
 */
export async function transferSharedMemoriesToDedicated(
  agent: SealedExportAgent,
  target: SharedMemoryTransferTarget,
  options: {
    exportImpl?: typeof exportSealedSharedMemories;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<SharedMemoryTransferResult> {
  // Refuse the target BEFORE reading anything or attaching the token.
  assertTransferTargetAllowed(target.baseUrl);
  const exportImpl = options.exportImpl ?? exportSealedSharedMemories;
  const fetchImpl = options.fetchImpl ?? fetch;

  const sealed = await exportImpl(agent);
  const result: SharedMemoryTransferResult = {
    rows: sealed.rows.length,
    batches: 0,
    imported: 0,
    skippedExisting: 0,
    embeddingsWritten: 0,
  };

  for (let start = 0; start < sealed.rows.length; start += SHARED_MEMORY_TRANSFER_MAX_ROWS) {
    const rows = sealed.rows.slice(start, start + SHARED_MEMORY_TRANSFER_MAX_ROWS);
    const response = await postBatch(target, batchSeal(sealed.seal, rows), rows, fetchImpl);
    validateBatchResponse(response, rows);
    result.batches += 1;
    result.imported += response.imported;
    result.skippedExisting += response.skipped_existing;
    result.embeddingsWritten += response.embeddings_written;
  }

  // Whole-export conservation against the sealed manifest.
  if (result.imported + result.skippedExisting !== sealed.seal.row_count) {
    throw new ElizaError("Memory transfer total does not conserve the seal", {
      code: SHARED_MEMORY_TRANSFER_FAILED,
      context: { ...result, sealedRowCount: sealed.seal.row_count },
    });
  }
  return result;
}
