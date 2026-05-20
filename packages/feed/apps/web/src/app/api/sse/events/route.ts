import {
  connections,
  ensureRedisReady,
  generateConnectionId,
  publicRateLimit,
  type RealtimeChannel,
  streamRead,
  toStreamKey,
  verifyRealtimeToken,
  withErrorHandling,
} from "@feed/api";
import { logger } from "@feed/shared";
import type { NextRequest } from "next/server";

// Vercel function configuration
// Max duration for SSE connections - 300s on Enterprise, 60s on Pro, 10s on Hobby
export const maxDuration = 300;

// Force dynamic to prevent caching, use nodejs runtime for streaming support
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_CHANNELS = 50;

// SSE optimization constants
// Use shorter blocking time for better responsiveness
// ioredis blocking reads can have issues in some environments
const BLOCK_TIMEOUT_MS = 1000; // Block for 1 second waiting for new messages
const HEARTBEAT_INTERVAL_MS = 15000; // Send heartbeat every 15 seconds
const MAX_MESSAGES_PER_READ = 100; // Max messages to read per iteration

interface CursorMap {
  [channel: string]: string;
}

const parseCursor = (raw: string | null): CursorMap => {
  if (!raw) return {};
  const decoded = decodeURIComponent(raw);
  const parsed = JSON.parse(decoded) as CursorMap;
  return parsed && typeof parsed === "object" ? parsed : {};
};

export const GET = withErrorHandling(async function GET(request: NextRequest) {
  const { error } = await publicRateLimit(request, "firehose");
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const tokenParam = searchParams.get("token");
  const cursorParam = searchParams.get("cursor");
  const requestedChannelsParam = searchParams.get("channels");

  if (!tokenParam) {
    return new Response("Missing token", { status: 401 });
  }

  const realtimePayload = verifyRealtimeToken(tokenParam);
  let allowedChannels: RealtimeChannel[] = realtimePayload?.channels ?? [];

  if (!realtimePayload?.userId) {
    return new Response("Unauthorized", { status: 401 });
  }

  const userId = realtimePayload.userId;

  // Ensure Redis is ready before starting SSE connection
  // This awaits initialization if still in progress
  const redis = await ensureRedisReady();
  if (!redis) {
    logger.error(
      "Redis/Upstash not configured - realtime disabled",
      undefined,
      "SSE",
    );
    return new Response("Realtime unavailable", { status: 503 });
  }

  // If the client passed an explicit channels list, intersect with token-authorized channels.
  if (requestedChannelsParam) {
    const decoded = decodeURIComponent(requestedChannelsParam);
    const requested = decoded
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean) as RealtimeChannel[];
    const requestedSet = new Set(requested);
    allowedChannels = allowedChannels.filter((ch) => requestedSet.has(ch));
  }

  if (allowedChannels.length === 0) {
    return new Response("No channels authorized", { status: 403 });
  }

  if (allowedChannels.length > MAX_CHANNELS) {
    return new Response("Too many channels requested", { status: 400 });
  }

  const encoder = new TextEncoder();
  const connectionId = generateConnectionId();
  const cursors = parseCursor(cursorParam);
  const streamKeys = allowedChannels.map(toStreamKey);
  const keyToChannel = new Map(
    streamKeys.map((k, idx) => [k, allowedChannels[idx]]),
  );
  const lastIds = new Map<string, string>();

  const stream = new ReadableStream({
    start: async (controller) => {
      connections.add({
        id: connectionId,
        userId,
        channels: allowedChannels,
        connectedAt: Date.now(),
      });

      let lastHeartbeat = Date.now();
      let isControllerClosed = false;

      const send = (payload: string): boolean => {
        if (isControllerClosed) return false;
        controller.enqueue(encoder.encode(payload));
        return true;
      };

      // Send heartbeat to keep connection alive and detect disconnects
      const sendHeartbeat = (): boolean => {
        const now = Date.now();
        if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
          lastHeartbeat = now;
          // SSE comment line (starts with :) is used as heartbeat
          return send(`: heartbeat ${now}\n\n`);
        }
        return true;
      };

      // Initial connected event
      send(
        "event: connected\n" +
          `data: ${JSON.stringify({
            connectionId,
            channels: allowedChannels,
            timestamp: Date.now(),
          })}\n\n`,
      );

      // Initialize lastIds with current stream positions to avoid race conditions.
      // Without this, XREAD with '$' misses messages added between connection and first read.
      // We get the latest entry ID from each stream and start reading from there.
      for (const streamKey of streamKeys) {
        const channelName = keyToChannel.get(streamKey);
        const cursorFromClient = channelName ? cursors[channelName] : undefined;

        // If client provided a cursor, use it (reconnection scenario)
        if (cursorFromClient) {
          lastIds.set(streamKey, cursorFromClient);
          continue;
        }

        // Otherwise, get the current last entry ID from the stream
        // This ensures we don't miss messages added right before we start reading
        try {
          const info = (await redis.xinfo("STREAM", streamKey)) as unknown[];
          // xinfo returns an array like ['length', 5, 'radix-tree-keys', 1, ..., 'last-entry', ['id', 'field', 'value'], ...]
          // or ['length', 5, ..., 'last-generated-id', '123-0', ...]
          // Find 'last-generated-id' in the array
          for (let i = 0; i < info.length - 1; i++) {
            if (
              info[i] === "last-generated-id" &&
              typeof info[i + 1] === "string"
            ) {
              lastIds.set(streamKey, info[i + 1] as string);
              break;
            }
          }
        } catch (err) {
          // Distinguish stream-not-found (expected) from other errors (unexpected)
          const errMsg = err instanceof Error ? err.message : String(err);
          const isStreamNotFound =
            errMsg.includes("no such key") ||
            errMsg.includes("ERR no such key");
          if (isStreamNotFound) {
            logger.debug("Stream does not exist yet", { streamKey }, "SSE");
          } else {
            logger.warn(
              "Unexpected error getting stream info",
              { streamKey, error: errMsg },
              "SSE",
            );
          }
        }
      }

      logger.debug(
        "SSE initialized lastIds",
        { streamKeys, lastIds: Object.fromEntries(lastIds) },
        "SSE",
      );

      const abortListener = () => {
        isControllerClosed = true;
        controller.close();
      };
      request.signal.addEventListener("abort", abortListener, { once: true });

      // Main event loop with blocking reads
      let loopCount = 0;
      while (!request.signal.aborted && !isControllerClosed) {
        loopCount++;

        // Send heartbeat if needed
        if (!sendHeartbeat()) {
          logger.debug(
            "Heartbeat failed, client disconnected",
            { connectionId },
            "SSE",
          );
          break;
        }

        const ids = streamKeys.map((k) => {
          const channelName = keyToChannel.get(k);
          const cursorId = channelName ? cursors[channelName] : undefined;
          // Priority: lastId (from previous reads) > cursor (from client) > '$' (new messages only)
          // For first read, use '$' to only get new messages (prevents replaying entire stream)
          // Client should pass cursor for reconnection scenarios
          return lastIds.get(k) || cursorId || "$";
        });

        // Debug: log every 15th iteration what IDs we're using (~15 seconds with 1s block)
        if (loopCount % 15 === 0) {
          logger.debug(
            "SSE streamRead parameters",
            { loopCount, streamKeys, ids, redisStatus: redis.status },
            "SSE",
          );
        }

        // Use blocking read - waits up to BLOCK_TIMEOUT_MS for new messages
        // This is more efficient than polling as it doesn't waste CPU cycles
        // Pass the redis client explicitly to avoid issues with getRedisClient() in hot-reload
        let messages: Awaited<ReturnType<typeof streamRead>> = [];
        try {
          messages = await streamRead(streamKeys, ids, {
            count: MAX_MESSAGES_PER_READ,
            block: BLOCK_TIMEOUT_MS,
            client: redis,
          });
        } catch (readError) {
          logger.error(
            "SSE streamRead error - continuing loop",
            {
              connectionId,
              error:
                readError instanceof Error
                  ? readError.message
                  : String(readError),
              loopCount,
            },
            "SSE",
          );
          // Wait a bit before retrying to avoid tight error loop
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }

        // No messages received (timeout), loop continues for heartbeat
        if (!messages || messages.length === 0) {
          // Log every 30 iterations (~30 seconds) at debug level to reduce noise
          if (loopCount % 30 === 0) {
            logger.debug(
              "SSE loop still running - no messages",
              {
                connectionId,
                loopCount,
                channels: allowedChannels,
                streamKeys,
                ids,
              },
              "SSE",
            );
          }
          continue;
        }

        logger.debug(
          "Realtime stream read",
          { connectionId, count: messages.length },
          "SSE",
        );

        for (const msg of messages) {
          const channel = keyToChannel.get(msg.stream);
          if (!channel) continue;

          // Unwrap payload if encoded as { payload: {...} }
          const raw = msg.payload as Record<string, unknown>;
          const payload =
            raw && typeof raw === "object" && "payload" in raw
              ? (raw as { payload: Record<string, unknown> }).payload
              : raw;

          // Always emit 'message' events; actual type stays in the payload for fan-out client-side.
          const eventType = "message";
          const innerType =
            payload &&
            typeof payload === "object" &&
            "type" in payload &&
            typeof (payload as { type: unknown }).type === "string"
              ? (payload as { type: string }).type
              : "message";
          const innerTimestamp =
            payload &&
            typeof payload === "object" &&
            "timestamp" in payload &&
            typeof (payload as { timestamp: unknown }).timestamp === "number"
              ? (payload as { timestamp: number }).timestamp
              : Date.now();
          const innerVersion =
            payload &&
            typeof payload === "object" &&
            "version" in payload &&
            typeof (payload as { version: unknown }).version === "string"
              ? (payload as { version: string }).version
              : undefined;

          const innerData =
            payload && typeof payload === "object" && "data" in payload
              ? (payload as { data: unknown }).data
              : payload;

          const sseData = JSON.stringify({
            channel,
            type: innerType,
            data: innerData,
            timestamp: innerTimestamp,
            version: innerVersion,
          });

          const packet = `id: ${msg.id}\nevent: ${eventType}\ndata: ${sseData}\n\n`;
          const ok = send(packet);
          if (!ok) {
            logger.debug(
              "Failed to enqueue SSE payload (client disconnected)",
              { connectionId },
              "SSE",
            );
            break;
          }

          lastIds.set(msg.stream, msg.id);
        }
      }

      // Log why the loop exited
      logger.info(
        "SSE loop exited",
        {
          connectionId,
          loopCount,
          aborted: request.signal.aborted,
          controllerClosed: isControllerClosed,
        },
        "SSE",
      );

      connections.remove(connectionId);
    },
    cancel() {
      connections.remove(connectionId);
    },
  });

  logger.info(
    "SSE connection established",
    {
      userId,
      connectionId,
      channels: allowedChannels,
      redisStatus: redis.status,
    },
    "SSE",
  );

  return new Response(stream, {
    headers: {
      // Standard SSE headers per spec
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Prevent buffering by nginx/proxies
      "X-Accel-Buffering": "no",
    },
  });
});
