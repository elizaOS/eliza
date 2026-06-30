/**
 * Deliver a sub-agent's screenshots/artifacts to the originating chat (#8904,
 * EPIC #8885).
 *
 * The router already forwards text, diffs, and verified URLs at task_complete
 * but never the visual proof. When a completion carries screenshot paths (in its
 * CompletionEnvelope, #8895, or stamped on `session.metadata.artifactPaths`),
 * this posts them to the origin room as media — connectors that render
 * `Content.attachments` (Telegram via `sendMedia` PHOTO) show them inline, so a
 * Telegram user sees what a Claude-Code user sees in-terminal.
 */

import { statSync } from "node:fs";
import type { Content, Media, UUID } from "@elizaos/core";
import { ContentType, logger } from "@elizaos/core";
import { parseCompletionEnvelope } from "./completion-envelope.js";

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
/** Cap how many screenshots we forward so a chatty task can't flood the chat. */
export const MAX_SCREENSHOTS = 5;

/**
 * Cap the cumulative BYTES forwarded (in addition to the count cap) so a task
 * with a few very large images can't blow the connector's upload limit or flood
 * the chat with megabytes — the second half of #8904's "cap count AND total
 * size". Overridable via `ELIZA_ORCHESTRATOR_SCREENSHOT_MAX_BYTES`; default 10 MB.
 */
export const MAX_SCREENSHOT_TOTAL_BYTES = (() => {
  const raw = process.env.ELIZA_ORCHESTRATOR_SCREENSHOT_MAX_BYTES;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 10 * 1024 * 1024;
})();

/** Default byte-size probe for a local screenshot path; 0 if unreadable. */
function fileSizeBytes(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

/**
 * Pure: cap screenshot paths by BOTH count and a cumulative byte budget (#8904).
 * The first path is always kept (so a single oversized shot is still delivered
 * rather than nothing); each subsequent path is dropped once the running total
 * would exceed `maxTotalBytes`. `sizeOf` is injectable so this is unit-testable
 * without real files; production uses `statSync`.
 */
export function capScreenshotPathsByBudget(
  paths: string[],
  {
    maxCount = MAX_SCREENSHOTS,
    maxTotalBytes = MAX_SCREENSHOT_TOTAL_BYTES,
    sizeOf = fileSizeBytes,
  }: {
    maxCount?: number;
    maxTotalBytes?: number;
    sizeOf?: (p: string) => number;
  } = {},
): string[] {
  const out: string[] = [];
  let total = 0;
  for (const p of paths) {
    if (out.length >= maxCount) break;
    let size = sizeOf(p);
    if (!Number.isFinite(size) || size < 0) size = 0;
    if (out.length > 0 && total + size > maxTotalBytes) break;
    total += size;
    out.push(p);
  }
  return out;
}

/**
 * Pure: collect candidate screenshot paths for a completion. Prefers the
 * validated CompletionEnvelope's `screenshotPaths`, then any
 * `metadata.artifactPaths`/`screenshotPaths`, deduped and filtered to
 * image-looking paths.
 */
export function collectScreenshotPaths(
  completionText: string | undefined,
  metadata: Record<string, unknown> | undefined,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: unknown) => {
    if (
      typeof p === "string" &&
      p.trim() &&
      IMAGE_EXT_RE.test(p) &&
      !seen.has(p)
    ) {
      seen.add(p);
      out.push(p);
    }
  };

  if (completionText) {
    const parsed = parseCompletionEnvelope(completionText);
    if (parsed.present && parsed.ok)
      for (const p of parsed.envelope.screenshotPaths) push(p);
  }
  if (metadata) {
    for (const key of ["screenshotPaths", "artifactPaths"]) {
      const v = metadata[key];
      if (Array.isArray(v)) for (const p of v) push(p);
    }
  }
  return out;
}

/** Pure: turn screenshot paths into capped image `Media[]` for `Content.attachments`. */
export function screenshotsToAttachments(
  paths: string[],
  maxCount = MAX_SCREENSHOTS,
): Media[] {
  return paths.slice(0, maxCount).map((p, i) => ({
    id: `screenshot-${i}` as UUID,
    url: p,
    title: p.split("/").pop() || `screenshot-${i}`,
    contentType: ContentType.IMAGE,
    source: "sub-agent",
  }));
}

type SendToTarget = (
  target: { source: string; roomId: UUID },
  content: Content,
) => Promise<unknown>;

/**
 * Post the collected screenshots to the origin room as a single media message.
 * Best-effort: no paths → no-op; a send failure is logged, never thrown (it must
 * not break the completion flow). Returns the count delivered.
 */
export async function deliverScreenshots(
  send: SendToTarget,
  target: { source: string; roomId: UUID },
  paths: string[],
  label?: string,
  opts?: { sizeOf?: (p: string) => number; maxTotalBytes?: number },
): Promise<number> {
  // Cap by count AND cumulative byte budget before building attachments (#8904),
  // so a few huge screenshots can't exceed the connector's upload limit.
  const budgeted = capScreenshotPathsByBudget(paths, {
    sizeOf: opts?.sizeOf,
    maxTotalBytes: opts?.maxTotalBytes,
  });
  const attachments = screenshotsToAttachments(budgeted);
  if (attachments.length === 0) return 0;
  const who = label ? ` from ${label}` : "";
  try {
    await send(target, {
      text: `📸 ${attachments.length} screenshot${attachments.length === 1 ? "" : "s"}${who}`,
      source: target.source,
      attachments,
    });
    return attachments.length;
  } catch (error) {
    logger.warn(
      `[screenshot-delivery] failed to deliver ${attachments.length} screenshot(s): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 0;
  }
}
