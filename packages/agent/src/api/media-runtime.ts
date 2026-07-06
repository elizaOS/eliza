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
  fetchRemoteMedia,
  logger,
  nodeLookupFn,
  nodePinnedFetch,
} from "@elizaos/core";
import {
  ensureThumbnailForStoredFile,
  gcUnreferencedMedia,
  handleMediaRouteRequest,
  isStoredMediaUrl,
  mediaFileNameFromUrl,
  persistAttachmentUrlIfInline,
  persistMediaBytes,
} from "./media-store.ts";

/** Cap on bytes pulled while rehosting a remote attachment into the store. */
const REHOST_MAX_BYTES = 50 * 1024 * 1024;

/** Media content types worth rehosting (skip `link` and unknown). */
const REHOSTABLE_CONTENT_TYPES = new Set([
  "image",
  "video",
  "audio",
  "document",
]);

/**
 * Rehost a remote (http/https) media URL into the content-addressed store via
 * the SSRF-guarded fetcher (blocks private/loopback) with a hard size cap, so an
 * agent-generated/provider URL that may expire becomes a durable, same-origin
 * `/api/media/<hash>` URL. Returns the served URL, or null on any failure
 * (blocked host, too large, unreachable) so the caller can keep the original.
 */
async function rehostRemoteMediaUrl(url: string): Promise<string | null> {
  try {
    const { buffer, contentType } = await fetchRemoteMedia({
      url,
      maxBytes: REHOST_MAX_BYTES,
      lookupFn: nodeLookupFn,
      pinnedFetchImpl: nodePinnedFetch,
    });
    return persistMediaBytes(buffer, contentType ?? "application/octet-stream")
      .url;
  } catch (err) {
    logger.warn(
      `[media-persist] failed to rehost ${url}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

const MEDIA_URL_PREFIX = "/api/media/";

/**
 * Public GET route for stored media. On HTTP platforms with a listening port
 * the pre-auth `serveMediaFile` handler answers first and this route is never
 * reached; it exists for the port-free native IPC path — iOS/desktop/Android
 * native scheme handlers (`eliza-local-agent://ipc/api/media/…`) that dispatch
 * in-process over `runtime.routes` with no HTTP server. The native bridge
 * base64-encodes the returned `Buffer` body losslessly.
 *
 * The `Range` request header is forwarded so `handleMediaRouteRequest` can
 * answer `206 Partial Content`, which is what lets `<audio>`/`<video>` seek
 * over the native scheme handler.
 */
export const mediaFileRoute: Route = {
  type: "GET",
  path: "/api/media/:filename",
  // Serve at the literal path, not under the plugin-name prefix.
  rawPath: true,
  public: true,
  name: "media-file",
  publicReason:
    "Media URLs are content-addressed capability links served pre-auth.",
  routeHandler: async (ctx) => {
    const filename = ctx.params?.filename ?? "";
    const result = handleMediaRouteRequest(
      `${MEDIA_URL_PREFIX}${filename}`,
      ctx.method ?? "GET",
      // `dispatchRoute` lowercases request headers before building the context.
      ctx.headers?.range,
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
        } else if (
          /^https?:\/\//i.test(attachment.url) &&
          !isStoredMediaUrl(attachment.url) &&
          typeof attachment.contentType === "string" &&
          REHOSTABLE_CONTENT_TYPES.has(attachment.contentType)
        ) {
          // Rehost remote agent-generated/outgoing media into the durable store
          // so a provider URL that may expire doesn't leave a broken tile in
          // history. SSRF-guarded + size-capped; on failure keep the original
          // URL and mark it ephemeral so the UI can offer a retry.
          const rehosted = await rehostRemoteMediaUrl(attachment.url);
          if (rehosted) {
            attachment.url = rehosted;
          } else {
            (attachment as { ephemeral?: boolean }).ephemeral = true;
          }
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

type MediaGcDiagnostics = Pick<IAgentRuntime, "logger" | "reportError">;

function transcriptContentFromMemory(memory: Memory): unknown {
  return (memory.content as { transcript?: unknown } | undefined)?.transcript;
}

function collectTranscriptAudioReference(
  memory: Memory,
  addUrl: (value: unknown) => void,
  diagnostics?: MediaGcDiagnostics,
): void {
  const raw = transcriptContentFromMemory(memory);
  if (raw === undefined) return;
  if (raw && typeof raw === "object") {
    addUrl((raw as { audioUrl?: unknown }).audioUrl);
    return;
  }
  if (typeof raw !== "string") return;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      addUrl((parsed as { audioUrl?: unknown }).audioUrl);
    }
  } catch (err) {
    // error-policy:J7 diagnostics-must-not-kill-the-loop — malformed transcript
    // rows should not abort media GC, but they must surface because an unreadable
    // row can hide a retained audio reference.
    const context = {
      memoryId: memory.id,
      roomId: memory.roomId,
      tableName: (memory as { tableName?: unknown }).tableName,
      field: "content.transcript",
    };
    const message = `[media-gc] failed to parse transcript media reference${
      memory.id ? ` for memory ${memory.id}` : ""
    }: ${err instanceof Error ? err.message : String(err)}`;
    if (diagnostics) {
      diagnostics.logger.warn(message);
      diagnostics.reportError("media-gc.transcript-reference", err, context);
    } else {
      logger.warn(message);
    }
  }
}

export function collectReferencedMedia(
  memories: Memory[],
  diagnostics?: MediaGcDiagnostics,
): Set<string> {
  const referenced = new Set<string>();
  // Validate at the jsonb boundary: `content`/`metadata` are untyped at rest,
  // so anything that hashes to a stored `<sha256>.<ext>` name is a live
  // referent, everything else is ignored.
  const addUrl = (value: unknown): void => {
    const name = mediaFileNameFromUrl(typeof value === "string" ? value : "");
    if (name) referenced.add(name);
  };
  for (const memory of memories) {
    const attachments = (
      memory.content as
        | { attachments?: Array<{ url?: unknown; thumbnailUrl?: unknown }> }
        | undefined
    )?.attachments;
    if (Array.isArray(attachments)) {
      for (const attachment of attachments) {
        // A stored image and its downscaled preview are two DISTINCT
        // content-addressed files (see `persistImageThumbnail` /
        // `ensureThumbnailForStoredFile`): the chat tile renders `thumbnailUrl`
        // while the lightbox opens the full-res `url`. Both are live referents,
        // but `thumbnailUrl` is invisible to a naive attachment scan — without
        // collecting it the daily GC orphans every thumbnail past the grace
        // window, so inline previews 404 even though the full image survives.
        addUrl(attachment?.url);
        addUrl(attachment?.thumbnailUrl);
      }
    }

    // Document-linked original-bytes files: a knowledge document references its
    // stored original via `metadata.mediaUrl` (no content.attachments entry).
    // Collect it so the file survives GC while the document still references it.
    // Transcript documents (voice sessions, meetings) additionally anchor the
    // retained recording via `metadata.audioUrl` — the key transcript readers
    // look up. Collect it too so a producer that set only `audioUrl` doesn't
    // leave its WAV invisible to the sweep and deleted after the grace window.
    const metadata = memory.metadata as
      | { mediaUrl?: unknown; audioUrl?: unknown }
      | undefined;
    addUrl(metadata?.mediaUrl);
    addUrl(metadata?.audioUrl);

    // Transcript rows persist the rich record as JSON in `content.transcript`.
    // Voice captures can retain their WAV solely through the record's `audioUrl`,
    // so the collector has to understand that shared transcript row shape rather
    // than depending on every writer to duplicate the URL into metadata.
    collectTranscriptAudioReference(memory, addUrl, diagnostics);
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
        gcUnreferencedMedia(collectReferencedMedia(memories, rt));
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
