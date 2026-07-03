import type { ServerResponse } from "node:http";

const LIFEOPS_INBOX_CHANNELS = [
  "gmail",
  "x_dm",
  "discord",
  "telegram",
  "signal",
  "imessage",
  "whatsapp",
  "sms",
] as const;

type LifeOpsInboxChannel = (typeof LIFEOPS_INBOX_CHANNELS)[number];

const LIFEOPS_INBOX_CHANNEL_SET = new Set<string>(LIFEOPS_INBOX_CHANNELS);

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function emptyChannelCounts(): Record<
  LifeOpsInboxChannel,
  { total: number; unread: number }
> {
  return Object.fromEntries(
    LIFEOPS_INBOX_CHANNELS.map((channel) => [channel, { total: 0, unread: 0 }]),
  ) as Record<LifeOpsInboxChannel, { total: number; unread: number }>;
}

function parseChannels(raw: string | null):
  | {
      ok: true;
      channels: LifeOpsInboxChannel[] | undefined;
    }
  | {
      ok: false;
      message: string;
    } {
  if (raw === null || raw.trim().length === 0) {
    return { ok: true, channels: undefined };
  }

  const channels: LifeOpsInboxChannel[] = [];
  for (const part of raw.split(",")) {
    const channel = part.trim().toLowerCase();
    if (!channel) continue;
    if (!LIFEOPS_INBOX_CHANNEL_SET.has(channel)) {
      return {
        ok: false,
        message: `channels must be a comma-separated subset of: ${LIFEOPS_INBOX_CHANNELS.join(", ")}`,
      };
    }
    channels.push(channel as LifeOpsInboxChannel);
  }
  return { ok: true, channels };
}

/**
 * Compatibility fallback for `GET /api/lifeops/inbox`.
 *
 * The inbox view is core, but the rich LifeOps inbox cache is still served by
 * `@elizaos/plugin-personal-assistant`. Desktop/cloud-shell builds may load the
 * inbox view without PA; when no plugin route handled the request, return the
 * stable empty wire shape instead of letting the renderer hit a noisy 404 loop.
 *
 * Dispatch placement matters: server.ts calls this after runtime plugin routes,
 * so PA's real route wins whenever it is installed.
 */
export function tryHandleLifeOpsInboxFallback(options: {
  pathname: string;
  method: string;
  url: URL;
  res: ServerResponse;
}): boolean {
  if (options.method !== "GET" || options.pathname !== "/api/lifeops/inbox") {
    return false;
  }

  const parsed = parseChannels(options.url.searchParams.get("channels"));
  if (!parsed.ok) {
    sendJson(options.res, 400, { error: parsed.message });
    return true;
  }

  sendJson(options.res, 200, {
    messages: [],
    channelCounts: emptyChannelCounts(),
    fetchedAt: new Date().toISOString(),
    // No PA means no connector-backed sources at all — an empty `sources`
    // list (paired with `available: false`) rather than fabricated health.
    sources: [],
    available: false,
    reason: "personal_assistant_unavailable",
    ...(parsed.channels ? { channels: parsed.channels } : {}),
  });
  return true;
}
