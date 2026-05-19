import { Transform, type TransformCallback } from "node:stream";
import type {
  IAgentRuntime,
  Route,
  RouteRequest,
  RouteResponse,
} from "@elizaos/core";
import type { MusicService } from "./service";
import { musicDebug } from "./utils/musicDebug";

type StreamingRouteRequest = RouteRequest & {
  get?: (name: string) => string | undefined;
  on?: (event: "close", listener: () => void) => unknown;
  protocol?: string;
};

type StreamingRouteResponse = RouteResponse & NodeJS.WritableStream;

function firstRouteValue(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function routeGuildId(req: RouteRequest): string | undefined {
  return firstRouteValue(req.query?.guildId) || req.params?.guildId;
}

function setRouteHeader(res: RouteResponse, name: string, value: string): void {
  res.setHeader?.(name, value);
}

/**
 * Encode metadata for Shoutcast/Icecast format
 * Metadata is injected every 8192 bytes (or as specified)
 */
function encodeShoutcastMetadata(title: string): Buffer {
  // Format: StreamTitle='title';
  const metadata = `StreamTitle='${title.replace(/'/g, "''")}';`;
  const metadataLength = Math.ceil(metadata.length / 16) * 16; // Must be multiple of 16
  const buffer = Buffer.alloc(metadataLength + 1);
  buffer[0] = metadataLength / 16; // Length in 16-byte blocks
  buffer.write(metadata, 1, "utf8");
  return buffer;
}

/**
 * Create a transform stream that injects Shoutcast metadata
 */
function createShoutcastStream(
  trackTitle: string,
  metadataInterval: number = 8192,
): Transform {
  let bytesSinceMetadata = 0;

  return new Transform({
    transform(
      chunk: Buffer,
      _encoding: BufferEncoding,
      callback: TransformCallback,
    ) {
      const chunks: Buffer[] = [];
      let offset = 0;

      while (offset < chunk.length) {
        const remaining = chunk.length - offset;
        const needed = metadataInterval - bytesSinceMetadata;
        const toTake = Math.min(remaining, needed);

        chunks.push(chunk.slice(offset, offset + toTake));
        bytesSinceMetadata += toTake;
        offset += toTake;

        // Inject metadata when we reach the interval
        if (bytesSinceMetadata >= metadataInterval) {
          chunks.push(encodeShoutcastMetadata(trackTitle));
          bytesSinceMetadata = 0;
        }
      }

      callback(null, Buffer.concat(chunks));
    },
  });
}

/**
 * Route handler to stream the currently playing audio
 * GET /music-player/stream?guildId=<guildId>&format=<format>
 * Supports both 'webm' (default) and 'shoutcast' formats
 */
async function streamAudioHandler(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const guildId = routeGuildId(req);
  const format = firstRouteValue(req.query?.format) || "ogg";
  const supportsShoutcast =
    format.toLowerCase() === "shoutcast" || format.toLowerCase() === "icecast";
  const streamingReq = req as StreamingRouteRequest;
  const streamingRes = res as StreamingRouteResponse;

  if (!guildId) {
    res.status(400).json({ error: "guildId is required" });
    return;
  }

  runtime.logger.info(
    `[WebStream] /stream request received for guildId=${guildId}`,
  );

  const musicService = runtime.getService("music") as MusicService;
  if (!musicService) {
    runtime.logger.warn(
      "[WebStream] Music service unavailable — returning 503",
    );
    res.status(503).json({ error: "Music service is not available" });
    return;
  }

  const currentTrack = musicService.getCurrentTrack(guildId);
  if (!currentTrack) {
    runtime.logger.info(
      `[WebStream] No current track for guildId=${guildId} — returning 404`,
    );
    musicDebug("stream 404 no current track", { guildId });
    res.status(404).json({ error: "No track is currently playing" });
    return;
  }

  musicDebug("stream open", {
    guildId,
    format,
    track: currentTrack.title,
  });

  try {
    // NEW ARCHITECTURE: Subscribe to broadcast
    //
    // WHY SUBSCRIPTION MODEL:
    // Old approach tried to pipe the same stream to multiple HTTP responses.
    // This caused "Premature close" errors - Node streams don't naturally support
    // multiple readers. When one web client disconnected, it affected others.
    //
    // NEW APPROACH:
    // Each web client gets their own independent stream from the broadcast.
    // - Client connects → subscribe() gives them a fresh PassThrough stream
    // - Client disconnects → unsubscribe() cleans up just their stream
    // - Other clients are completely unaffected
    //
    // WHY UNIQUE CLIENT ID:
    // The broadcast tracks subscribers by ID. Each web connection needs a unique
    // identifier so it can be independently managed (subscribe/unsubscribe).
    //
    // DISCORD IMPACT:
    // None. Discord is subscribed as `discord-${guildId}`. Web clients are
    // `web-${timestamp}-${random}`. They're independent subscribers to the same
    // broadcast, like different radios tuned to the same station.
    const broadcast = musicService.getBroadcast(guildId);
    const clientId = `web-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const subscription = broadcast.subscribe(clientId);
    const listenerStream = subscription.stream;

    musicDebug("stream subscribed to broadcast", {
      guildId,
      clientId,
      subscribers: broadcast.getSubscriberCount(),
    });
    runtime.logger.debug(
      `[WebStream] Client ${clientId} subscribed to broadcast for guild ${guildId}`,
    );

    if (supportsShoutcast) {
      // Shoutcast/Icecast format with metadata injection
      setRouteHeader(res, "Content-Type", "audio/mpeg");
      setRouteHeader(res, "icy-name", runtime.character.name || "Music Player");
      setRouteHeader(res, "icy-genre", "Various");
      setRouteHeader(
        res,
        "icy-url",
        `${streamingReq.protocol ?? "http"}://${streamingReq.get?.("host") ?? "localhost"}`,
      );
      setRouteHeader(res, "icy-pub", "1");
      setRouteHeader(res, "icy-br", "128"); // Bitrate (approximate)
      setRouteHeader(res, "icy-metaint", "8192"); // Metadata interval in bytes
      setRouteHeader(res, "Cache-Control", "no-cache");
      setRouteHeader(res, "Connection", "keep-alive");
      setRouteHeader(res, "X-Content-Type-Options", "nosniff");

      // Create stream with metadata injection
      const shoutcastStream = createShoutcastStream(currentTrack.title, 8192);

      // Pipe broadcast stream through metadata injector to response
      listenerStream.pipe(shoutcastStream).pipe(streamingRes);

      // Clean up on client disconnect
      streamingReq.on?.("close", () => {
        subscription.unsubscribe();
        shoutcastStream.destroy();
        runtime.logger.debug(
          `[WebStream] Client ${clientId} disconnected (Shoutcast)`,
        );
      });
    } else {
      // Ogg Opus: matches StreamCore output after ELIZA_MUSIC_BROADCAST_NORMALIZE
      // (yt-dlp cache/temp files are Ogg Opus; `audio/webm` mislabeling = silent playback).
      setRouteHeader(res, "Content-Type", "audio/ogg; codecs=opus");
      setRouteHeader(res, "Cache-Control", "no-cache");
      setRouteHeader(res, "Connection", "keep-alive");
      setRouteHeader(res, "X-Content-Type-Options", "nosniff");

      // Pipe broadcast stream to response
      listenerStream.pipe(streamingRes);

      // Clean up on client disconnect
      streamingReq.on?.("close", () => {
        subscription.unsubscribe();
        runtime.logger.debug(
          `[WebStream] Client ${clientId} disconnected (Ogg Opus)`,
        );
      });
    }

    // Handle stream errors
    listenerStream.on("error", (error) => {
      if (!res.headersSent) {
        res.status(500).json({ error: "Stream error occurred" });
      }
      runtime.logger.error(`Web listener stream error: ${error}`);
    });
  } catch (error) {
    runtime.logger.error(`Error creating audio stream: ${error}`);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to create audio stream" });
    }
  }
}

/**
 * Route handler to get current track information
 * GET /music-player/now-playing?guildId=<guildId>
 */
async function nowPlayingHandler(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const guildId = routeGuildId(req);

  if (!guildId) {
    res.status(400).json({ error: "guildId is required" });
    return;
  }

  const musicService = runtime.getService("music") as MusicService;
  if (!musicService) {
    res.status(503).json({ error: "Music service is not available" });
    return;
  }

  const currentTrack = musicService.getCurrentTrack(guildId);
  if (!currentTrack) {
    res.status(404).json({ error: "No track is currently playing" });
    return;
  }

  res.status(200).json({
    track: {
      id: currentTrack.id,
      title: currentTrack.title,
      url: currentTrack.url,
      duration: currentTrack.duration,
      requestedBy: currentTrack.requestedBy,
      addedAt: currentTrack.addedAt,
    },
    streamUrl: `/music-player/stream?guildId=${guildId}`,
  });
}

/**
 * Route handler to get queue information
 * GET /music-player/queue?guildId=<guildId>
 */
async function queueHandler(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const guildId = routeGuildId(req);

  if (!guildId) {
    res.status(400).json({ error: "guildId is required" });
    return;
  }

  const musicService = runtime.getService("music") as MusicService;
  if (!musicService) {
    res.status(503).json({ error: "Music service is not available" });
    return;
  }

  const currentTrack = musicService.getCurrentTrack(guildId);
  const queue = musicService.getQueueList(guildId);

  res.status(200).json({
    currentTrack: currentTrack
      ? {
          id: currentTrack.id,
          title: currentTrack.title,
          url: currentTrack.url,
          duration: currentTrack.duration,
          requestedBy: currentTrack.requestedBy,
          addedAt: currentTrack.addedAt,
        }
      : null,
    queue: queue.map((track) => ({
      id: track.id,
      title: track.title,
      url: track.url,
      duration: track.duration,
      requestedBy: track.requestedBy,
      addedAt: track.addedAt,
    })),
    queueLength: queue.length,
  });
}

/**
 * Find the first guild with an actively playing track.
 * Returns { guildId, track } or null if nothing is playing anywhere.
 */
function findActiveGuild(musicService: MusicService): {
  guildId: string;
  track: ReturnType<MusicService["getCurrentTrack"]>;
} | null {
  const queues = musicService.getQueues();
  for (const [guildId] of queues) {
    const track = musicService.getCurrentTrack(guildId);
    if (track) return { guildId, track };
  }
  return null;
}

/**
 * Route handler for global playback status (no guildId required).
 * GET /music-player/status
 * Returns the first active guild + its current track, or 404 if nothing is playing.
 */
async function statusHandler(
  _req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const musicService = runtime.getService("music") as MusicService;
  if (!musicService) {
    res.status(503).json({ error: "Music service is not available" });
    return;
  }

  const active = findActiveGuild(musicService);
  if (!active) {
    res.status(200).json({ error: "No track is currently playing" });
    return;
  }

  res.status(200).json({
    guildId: active.guildId,
    track: {
      id: active.track?.id,
      title: active.track?.title,
      url: active.track?.url,
      duration: active.track?.duration,
      requestedBy: active.track?.requestedBy,
      addedAt: active.track?.addedAt,
    },
    isPaused: musicService.getIsPaused(active.guildId),
    streamUrl: `/music-player/stream?guildId=${encodeURIComponent(active.guildId)}`,
  });
}

// ── Authenticated control (DJ booth) — NOT public radio ─────────────────

/**
 * Parse optional JSON body for POST /control/* (no express.json on plugin routes).
 */
async function readControlJsonBody(
  req: RouteRequest,
): Promise<Record<string, unknown>> {
  if (req.body) {
    return req.body;
  }
  const stream = req as RouteRequest &
    AsyncIterable<Buffer | string | Uint8Array>;
  if (typeof stream[Symbol.asyncIterator] !== "function") {
    return {};
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Resolve guildId from JSON body, query string, or first active guild.
 */
function resolveControlGuildId(
  req: RouteRequest,
  body: Record<string, unknown>,
  musicService: MusicService,
): string | null {
  const fromBody =
    typeof body.guildId === "string" && body.guildId.trim()
      ? body.guildId.trim()
      : undefined;
  const q = req.query?.guildId;
  const fromQuery =
    typeof q === "string" && q.trim()
      ? q.trim()
      : Array.isArray(q) && typeof q[0] === "string"
        ? q[0].trim()
        : undefined;
  if (fromBody) return fromBody;
  if (fromQuery) return fromQuery;
  const active = findActiveGuild(musicService);
  return active?.guildId ?? null;
}

async function controlPauseHandler(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const musicService = runtime.getService("music") as MusicService;
  if (!musicService) {
    res.status(503).json({ error: "Music service is not available" });
    return;
  }
  const body = await readControlJsonBody(req);
  const guildId = resolveControlGuildId(req, body, musicService);
  if (!guildId) {
    res.status(404).json({ error: "No active playback to pause" });
    return;
  }
  await musicService.pause(guildId);
  runtime.logger.info(`[MusicControl] Paused playback for guild ${guildId}`);
  res.status(200).json({ ok: true, guildId, state: "paused" });
}

async function controlResumeHandler(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const musicService = runtime.getService("music") as MusicService;
  if (!musicService) {
    res.status(503).json({ error: "Music service is not available" });
    return;
  }
  const body = await readControlJsonBody(req);
  const guildId = resolveControlGuildId(req, body, musicService);
  if (!guildId) {
    res.status(404).json({ error: "No active playback to resume" });
    return;
  }
  await musicService.resume(guildId);
  runtime.logger.info(`[MusicControl] Resumed playback for guild ${guildId}`);
  res.status(200).json({ ok: true, guildId, state: "playing" });
}

async function controlStopHandler(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const musicService = runtime.getService("music") as MusicService;
  if (!musicService) {
    res.status(503).json({ error: "Music service is not available" });
    return;
  }
  const body = await readControlJsonBody(req);
  const guildId = resolveControlGuildId(req, body, musicService);
  if (!guildId) {
    res.status(404).json({ error: "No active playback to stop" });
    return;
  }
  await musicService.stopPlayback(guildId);
  musicService.clear(guildId);
  runtime.logger.info(`[MusicControl] Stopped playback for guild ${guildId}`);
  res.status(200).json({ ok: true, guildId, state: "stopped" });
}

async function controlSkipHandler(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const musicService = runtime.getService("music") as MusicService;
  if (!musicService) {
    res.status(503).json({ error: "Music service is not available" });
    return;
  }
  const body = await readControlJsonBody(req);
  const guildId = resolveControlGuildId(req, body, musicService);
  if (!guildId) {
    res.status(404).json({ error: "No active playback to skip" });
    return;
  }
  const skipped = await musicService.skip(guildId);
  if (!skipped) {
    res.status(404).json({ error: "No track to skip" });
    return;
  }
  const nextTrack = musicService.getCurrentTrack(guildId);
  runtime.logger.info(
    `[MusicControl] Skipped track for guild ${guildId}${nextTrack ? ` → ${nextTrack.title}` : ""}`,
  );
  res.status(200).json({
    ok: true,
    guildId,
    nextTrack: nextTrack
      ? { id: nextTrack.id, title: nextTrack.title, url: nextTrack.url }
      : null,
  });
}

/**
 * Routes for the music player plugin.
 *
 * Two tiers:
 * - **Public radio** (`public: true`): GET stream, status, queue — any listener,
 *   no auth. `<audio>` cannot send Bearer tokens; keep streams here.
 * - **DJ booth** (`public: false`): POST /control/* — same API token as the
 *   dashboard (`Authorization: Bearer`, `X-Eliza-Token`, or `X-Api-Key`).
 *   Operators and automation use this; it is not mixed with public GET paths.
 *
 * **Agentic path:** the chat action PLAYBACK_OP (op=pause|resume|skip|stop|queue)
 * still routes control through the agent for natural language.
 */
export const musicPlayerRoutes: Route[] = [
  {
    type: "GET",
    path: "/stream",
    public: true,
    name: "Stream Audio",
    handler: streamAudioHandler,
  },
  {
    type: "GET",
    path: "/stream/:guildId",
    public: true,
    name: "Stream Audio (with guildId param)",
    handler: streamAudioHandler,
  },
  {
    type: "GET",
    path: "/now-playing",
    public: true,
    name: "Now Playing",
    handler: nowPlayingHandler,
  },
  {
    type: "GET",
    path: "/now-playing/:guildId",
    public: true,
    name: "Now Playing (with guildId param)",
    handler: nowPlayingHandler,
  },
  {
    type: "GET",
    path: "/queue",
    public: true,
    name: "Queue",
    handler: queueHandler,
  },
  {
    type: "GET",
    path: "/queue/:guildId",
    public: true,
    name: "Queue (with guildId param)",
    handler: queueHandler,
  },
  {
    type: "GET",
    path: "/status",
    public: true,
    name: "Playback Status",
    handler: statusHandler,
  },
  {
    type: "POST",
    path: "/control/pause",
    public: false,
    name: "Pause playback (authenticated)",
    handler: controlPauseHandler,
  },
  {
    type: "POST",
    path: "/control/resume",
    public: false,
    name: "Resume playback (authenticated)",
    handler: controlResumeHandler,
  },
  {
    type: "POST",
    path: "/control/stop",
    public: false,
    name: "Stop playback (authenticated)",
    handler: controlStopHandler,
  },
  {
    type: "POST",
    path: "/control/skip",
    public: false,
    name: "Skip track (authenticated)",
    handler: controlSkipHandler,
  },
];
