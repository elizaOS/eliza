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
/** Cap the total known screenshot bytes in one completion delivery. */
export const MAX_SCREENSHOT_TOTAL_BYTES = 20 * 1024 * 1024;

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

type ScreenshotAttachmentOptions = {
  maxCount?: number;
  maxTotalBytes?: number;
  getSize?: (path: string) => number | undefined;
};

function getFileSize(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}

function normalizeAttachmentOptions(
  maxCountOrOptions: number | ScreenshotAttachmentOptions,
): Required<ScreenshotAttachmentOptions> {
  if (typeof maxCountOrOptions === "number") {
    return {
      maxCount: maxCountOrOptions,
      maxTotalBytes: MAX_SCREENSHOT_TOTAL_BYTES,
      getSize: getFileSize,
    };
  }
  return {
    maxCount: maxCountOrOptions.maxCount ?? MAX_SCREENSHOTS,
    maxTotalBytes:
      maxCountOrOptions.maxTotalBytes ?? MAX_SCREENSHOT_TOTAL_BYTES,
    getSize: maxCountOrOptions.getSize ?? getFileSize,
  };
}

/** Turn screenshot paths into capped image `Media[]` for `Content.attachments`. */
export function screenshotsToAttachments(
  paths: string[],
  maxCountOrOptions: number | ScreenshotAttachmentOptions = MAX_SCREENSHOTS,
): Media[] {
  const { maxCount, maxTotalBytes, getSize } =
    normalizeAttachmentOptions(maxCountOrOptions);
  const selected: string[] = [];
  let totalBytes = 0;
  for (const path of paths) {
    if (selected.length >= maxCount) break;
    const size = getSize(path);
    if (typeof size === "number" && Number.isFinite(size)) {
      if (size > maxTotalBytes || totalBytes + size > maxTotalBytes) continue;
      totalBytes += size;
    }
    selected.push(path);
  }
  return selected.map((p, i) => ({
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
): Promise<number> {
  const attachments = screenshotsToAttachments(paths);
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
