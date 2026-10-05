/** Provides byte-exact traversal and bounded adapter helpers for the deterministic evidence producer. */

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

const PAGE_BYTES = 64 * 1024;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function traverseTarget(target, object) {
  const digest = createHash("sha256");
  const rows = [];
  let offset = 0;
  let bytesRead = 0;
  let rowsReadMax = 0;
  let parentScans = 0;
  let maxPageLatencyMs = 0;
  while (offset < target.object.byteLength) {
    const startedAt = performance.now();
    const page = await target.read({
      access: "authorized",
      offset,
      limit: PAGE_BYTES,
      expectedRevision: target.object.revision,
    });
    maxPageLatencyMs = Math.max(
      maxPageLatencyMs,
      performance.now() - startedAt,
    );
    if (page.bytes.byteLength === 0) {
      throw new Error(`target made no progress for ${object.id}`);
    }
    const start = page.view.slice.range.start;
    const end = page.view.slice.range.end;
    digest.update(page.bytes);
    bytesRead += page.sourceWork.bytesRead;
    rowsReadMax = Math.max(rowsReadMax, page.sourceWork.rowsRead);
    parentScans += page.sourceWork.parentScans;
    rows.push({
      objectId: object.id,
      revision: object.revision,
      sliceSha256: sha256(page.bytes),
      range: { unit: "byte", start, end },
      bytesRead: page.bytes.byteLength,
    });
    offset = end;
  }
  const reassembledSha256 = digest.digest("hex");
  if (reassembledSha256 !== object.sourceSha256) {
    throw new Error(`target traversal hash differs for ${object.id}`);
  }
  const finalRow = rows.at(-1);
  if (finalRow) finalRow.reassembledSha256 = reassembledSha256;
  return {
    rows,
    maxPageLatencyMs,
    sourceWork: {
      objectId: object.id,
      rowsRead: rowsReadMax,
      parentScans,
      bytesRead,
      bytesReturned: object.byteLength,
    },
  };
}

export function createDeterministicTargetAdapter(
  target,
  adapterId,
  maxPageBytes = Number.MAX_SAFE_INTEGER,
) {
  return {
    adapterId,
    deliveryContract: "explicit-native-paging-no-automatic-prompt-omission",
    async read(request) {
      return target.read({
        access:
          request.authorizationScope === target.object.authorizationScope
            ? "authorized"
            : "unauthorized",
        offset: request.offset,
        limit: Math.min(request.limit, maxPageBytes),
        expectedRevision: request.expectedRevision,
      });
    },
    restart: () => target.restart(),
    cleanup: () => target.cleanup(),
  };
}
