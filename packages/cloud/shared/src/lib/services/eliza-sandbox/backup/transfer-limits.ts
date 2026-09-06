/** Reads snapshot transfer bodies against explicit transport limits and rejects incomplete or oversized state. Error-body excerpts are diagnostics only and never become restored agent context. */
import { resolveRetainableAgentBackupBytes } from "@elizaos/shared/agent-backup-limits";
import { type AgentBackupStateData } from "../../../../db/schemas/agent-sandboxes";

/**
 * Maximum bytes to read from a snapshot-fetch error response body for
 * diagnostic logging (#18228). The body distinguishes an agent-side 500
 * (carries the thrown error message) from a bridge/proxy-hop 500 (proxy
 * error page or empty). Bounded so a malicious or misconfigured upstream
 * cannot exhaust Worker memory.
 */
export const SNAPSHOT_ERROR_BODY_EXCERPT_BYTES = 512;

/**
 * Hydration budgets (#16639): the worker heap died buffering unbounded
 * snapshot bodies (`res.json()` retained everything, then a re-stringify
 * doubled it). The raw budget is enforced WHILE streaming — bytes past it are
 * never retained — and the expanded file budgets are validated before the
 * payload is persisted. Env-overridable for staging soak.
 *
 * The raw budget is the RETAIN side of the v1 wire contract, so it is bounded
 * by what restore accepts: the override may lower it, never raise it past
 * `MAX_RESTORABLE_AGENT_BACKUP_BYTES` (#17172). Retaining more than that
 * yields a snapshot that authorizes a cutover and can never be restored.
 */
export const SNAPSHOT_MAX_RAW_BYTES = resolveRetainableAgentBackupBytes(
  process.env.ELIZA_SNAPSHOT_MAX_RAW_BYTES,
);

export const SNAPSHOT_MAX_FILES = (() => {
  const raw = Number.parseInt(process.env.ELIZA_SNAPSHOT_MAX_FILES ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 5_000;
})();

export const SNAPSHOT_MAX_EXPANDED_BYTES = (() => {
  const raw = Number.parseInt(process.env.ELIZA_SNAPSHOT_MAX_EXPANDED_BYTES ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 384 * 1024 * 1024;
})();

/**
 * Stream a Response body, enforcing a hard byte budget (#16639): the read is
 * aborted the moment the counted bytes exceed the budget, so an oversized
 * snapshot can never be retained in memory. Fail-closed with an explicit,
 * observable error.
 */
export async function readBodyWithinBudget(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    if (Buffer.byteLength(text, "utf-8") > maxBytes) {
      throw new Error(
        `Snapshot payload exceeds the raw hydration budget (${maxBytes} bytes) — refusing to retain it`,
      );
    }
    return text;
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        if (received > maxBytes) {
          throw new Error(
            `Snapshot payload exceeds the raw hydration budget (${maxBytes} bytes) — refusing to retain it`,
          );
        }
        chunks.push(value);
      }
    }
  } finally {
    // Release the connection whether we finished or bailed over budget.
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Validate the parsed snapshot's expanded budgets BEFORE it is persisted
 * (#16639): total file count and summed content bytes across the legacy
 * `workspaceFiles` map and the durable manifest files. Fail-closed — a
 * payload over budget is rejected outright, never partially restored.
 */
export function assertSnapshotExpandedBudgets(stateData: AgentBackupStateData): void {
  let files = 0;
  let expandedBytes = 0;
  const workspace = stateData.workspaceFiles ?? {};
  for (const content of Object.values(workspace)) {
    files += 1;
    expandedBytes += typeof content === "string" ? Buffer.byteLength(content, "utf-8") : 0;
  }
  const components = stateData.manifest?.components;
  if (components) {
    const fileSets = [
      components.database?.pglite,
      components.media,
      components.vault,
      components.stateFiles,
    ];
    for (const fileSet of fileSets) {
      for (const entry of fileSet?.files ?? []) {
        files += 1;
        // `size` is the declared decoded size; the base64 payload is the
        // retained one — count the larger of the two so a lying manifest
        // cannot under-declare.
        const decoded =
          typeof entry.bytesBase64 === "string"
            ? Math.floor((entry.bytesBase64.length * 3) / 4)
            : 0;
        expandedBytes += Math.max(typeof entry.size === "number" ? entry.size : 0, decoded);
      }
    }
    const configFile = components.character?.configFile;
    if (configFile) {
      files += 1;
      expandedBytes +=
        typeof configFile.bytesBase64 === "string"
          ? Math.floor((configFile.bytesBase64.length * 3) / 4)
          : 0;
    }
  }
  if (files > SNAPSHOT_MAX_FILES) {
    throw new Error(
      `Snapshot exceeds the file budget (${files} > ${SNAPSHOT_MAX_FILES}) — refusing to retain it`,
    );
  }
  if (expandedBytes > SNAPSHOT_MAX_EXPANDED_BYTES) {
    throw new Error(
      `Snapshot exceeds the expanded byte budget (${expandedBytes} > ${SNAPSHOT_MAX_EXPANDED_BYTES}) — refusing to retain it`,
    );
  }
}

/**
 * Read a bounded excerpt of an error response body for diagnostic logging.
 * Returns a trimmed string or null when the body is empty. Used by
 * `fetchSnapshotState` (#18228) so an agent-side 500 (carrying the thrown
 * error message) is distinguishable from a bridge/proxy-hop 500 (proxy error
 * page or empty body) in Worker logs.
 *
 * Streams the body via a ReadableStream reader and stops after
 * SNAPSHOT_ERROR_BODY_EXCERPT_BYTES of UTF-8, cancelling the remainder —
 * never buffering the full response (a malicious upstream could OOM the
 * Worker with an unbounded body).
 */
export async function readErrorBodyExcerpt(
  res: Pick<Response, "body" | "headers">,
): Promise<string | null> {
  // error-policy:J2 non-blocking diagnostic — a body-read failure degrades to
  // a null excerpt (status-only message) without aborting the snapshot path.
  try {
    if (!res.body) return null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const chunks: string[] = [];
    let totalBytes = 0;
    try {
      // error-policy:J2 stream cancellation after the byte budget is reached.
      while (totalBytes < SNAPSHOT_ERROR_BODY_EXCERPT_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = SNAPSHOT_ERROR_BODY_EXCERPT_BYTES - totalBytes;
        const sliced = value.length >= remaining ? truncateUtf8Bytes(value, remaining) : value;
        chunks.push(decoder.decode(sliced, { stream: true }));
        totalBytes += sliced.length;
      }
    } finally {
      // Cancel the reader to release the connection even if the body is larger.
      await reader.cancel().catch(() => {});
    }
    // Flush any trailing multi-byte UTF-8 sequence held by the stream decoder.
    chunks.push(decoder.decode());
    const body = chunks.join("");
    if (!body.trim()) return null;
    const contentType = res.headers.get("content-type") ?? "";
    // JSON error bodies carry structured diagnostics — try to extract a message.
    if (contentType.includes("application/json")) {
      try {
        const data = JSON.parse(body) as { error?: unknown; message?: unknown };
        const msg = data.error ?? data.message;
        if (typeof msg === "string" && msg.trim()) {
          return msg.trim();
        }
      } catch {
        // Not valid JSON — fall through to raw excerpt.
      }
    }
    return body.trim();
  } catch {
    return null;
  }
}

/** Truncate UTF-8 bytes without splitting a multi-byte code point. */
export function truncateUtf8Bytes(bytes: Uint8Array, maxBytes: number): Uint8Array {
  const limit = Math.min(bytes.length, maxBytes);
  let safeEnd = limit;
  while (safeEnd > 0) {
    const byte = bytes[safeEnd - 1]!;
    if ((byte & 0x80) === 0) {
      return bytes.slice(0, safeEnd);
    }
    if ((byte & 0xc0) === 0x80) {
      safeEnd--;
      continue;
    }
    let sequenceLength = 1;
    if ((byte & 0xf8) === 0xf0) sequenceLength = 4;
    else if ((byte & 0xf0) === 0xe0) sequenceLength = 3;
    else if ((byte & 0xe0) === 0xc0) sequenceLength = 2;
    if (safeEnd - 1 + sequenceLength <= limit) {
      return bytes.slice(0, limit);
    }
    return bytes.slice(0, safeEnd - 1);
  }
  return bytes.slice(0, 0);
}
