/**
 * Runtime wiring for the local media store: a public route so on-device iOS
 * (in-process dispatch, no HTTP server) can serve media, an outgoing hook that
 * persists inline `data:` URLs to the store before they hit the DB/context, and
 * a periodic GC task that sweeps orphaned files.
 *
 * The pure store lives in `./media-store.ts`; this module only connects it to
 * the runtime (routes / pipeline hooks / tasks).
 */

import type { IAgentRuntime, Memory, Route } from "@elizaos/core";
import {
  ensureThumbnailForStoredFile,
  gcUnreferencedMedia,
  handleMediaRouteRequest,
  isStoredMediaUrl,
  mediaFileNameFromUrl,
  persistAttachmentUrlIfInline,
} from "./media-store.ts";

const MEDIA_URL_PREFIX = "/api/media/";

/**
 * Public GET route for stored media. On HTTP platforms (browser, desktop,
 * Android) the pre-auth `serveMediaFile` handler answers first and this route
 * is never reached; it exists for iOS, where requests are dispatched in-process
 * over `runtime.routes` with no HTTP server. The native bridge base64-encodes
 * the returned `Buffer` body losslessly.
 */
export const mediaFileRoute: Route = {
  type: "GET",
  path: "/api/media/:filename",
  // Serve at the literal path, not under the plugin-name prefix.
  rawPath: true,
  public: true,
  name: "media-file",
  routeHandler: async (ctx) => {
    const filename = ctx.params?.filename ?? "";
    const result = handleMediaRouteRequest(
      `${MEDIA_URL_PREFIX}${filename}`,
      ctx.method ?? "GET",
    );
    return {
      status: result.status,
      headers: result.headers,
      ...(result.body !== undefined ? { body: result.body } : {}),
    };
  },
};

/**
 * Persist agent-generated / inline `data:` URL attachments to the content-
 * addressed store before the response is delivered + persisted, so a compact
 * served `/api/media/<hash>` URL lands in the message record instead of a
 * multi-KB base64 blob (which would bloat history + the agent's own context),
 * and pre-compute a thumbnail for stored images so the chat tile loads small.
 * Runs on `outgoing_before_deliver`, a mutator phase, so the rewrite propagates
 * to both the wire response and the saved memory.
 */
export function registerMediaPipelineHook(runtime: IAgentRuntime): void {
  runtime.registerPipelineHook({
    id: "media-persist-inline-attachments",
    phase: "outgoing_before_deliver",
    handler: async (_rt, ctx) => {
      if (ctx.phase !== "outgoing_before_deliver") return;
      const attachments = ctx.content?.attachments;
      if (!Array.isArray(attachments) || attachments.length === 0) return;
      for (const attachment of attachments) {
        if (!attachment || typeof attachment.url !== "string") continue;
        if (attachment.url.startsWith("data:")) {
          attachment.url = persistAttachmentUrlIfInline(attachment.url);
        }
        // Pre-compute a thumbnail for stored images lacking one (generated
        // media). `ensureThumbnailForStoredFile` self-gates on image mime/size.
        if (!attachment.thumbnailUrl && isStoredMediaUrl(attachment.url)) {
          const fileName = mediaFileNameFromUrl(attachment.url);
          if (fileName) {
            const thumbUrl = await ensureThumbnailForStoredFile(fileName);
            if (thumbUrl) attachment.thumbnailUrl = thumbUrl;
          }
        }
      }
    },
  });
}

const MEDIA_GC_TASK_NAME = "MEDIA_GC";
const MEDIA_GC_TAGS = ["queue", "repeat", "media-gc"];
const MEDIA_GC_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

function collectReferencedMedia(memories: Memory[]): Set<string> {
  const referenced = new Set<string>();
  for (const memory of memories) {
    const attachments = (
      memory.content as { attachments?: Array<{ url?: unknown }> } | undefined
    )?.attachments;
    if (!Array.isArray(attachments)) continue;
    for (const attachment of attachments) {
      const url = typeof attachment?.url === "string" ? attachment.url : "";
      const name = mediaFileNameFromUrl(url);
      if (name) referenced.add(name);
    }
  }
  return referenced;
}

/**
 * Register the orphan-media GC: a daily task that diffs every live message
 * attachment URL against the store and deletes files no message references
 * (respecting the store's grace window). Runs wherever the agent runs —
 * desktop/server (Node), Android, and iOS on-device.
 */
export function registerMediaGcTask(runtime: IAgentRuntime): void {
  runtime.registerTaskWorker({
    name: MEDIA_GC_TASK_NAME,
    execute: async (rt) => {
      try {
        const memories = await rt.getAllMemories();
        gcUnreferencedMedia(collectReferencedMedia(memories));
      } catch (err) {
        rt.logger.warn(
          `[media-gc] sweep failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return undefined;
    },
  });

  void (async () => {
    try {
      const existing = await runtime.getTasks({
        agentIds: [runtime.agentId],
        tags: MEDIA_GC_TAGS,
      });
      if (existing.some((task) => task.name === MEDIA_GC_TASK_NAME)) return;
      await runtime.createTask({
        name: MEDIA_GC_TASK_NAME,
        description: "Garbage-collect unreferenced local media files",
        tags: [...MEDIA_GC_TAGS],
        agentId: runtime.agentId,
        metadata: {
          updateInterval: MEDIA_GC_INTERVAL_MS,
          updatedAt: Date.now(),
        },
      });
    } catch (err) {
      runtime.logger.warn(
        `[media-gc] failed to schedule GC task: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  })();
}
