/**
 * Adapts the cloud voice session's canonical Eliza SSE request to a loopback
 * self-hosted runtime conversation stream. The voice orchestrator and SSE
 * decoder remain unchanged; this boundary only rewrites the route shape and
 * removes cloud-only credentials.
 */

import { REALTIME_VOICE_CLIENT_TRANSPORT } from "@elizaos/shared";
import { VOICE_STREAM_PROTOCOL } from "@/lib/voice-session/eliza-sse-bridge";

const CLOUD_CONVERSATION_STREAM_PATH =
  /^\/api\/v1\/eliza\/agents\/[^/]+\/api\/conversations\/([^/]+)\/messages\/stream$/;

export class LocalRuntimeConversationFetchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalRuntimeConversationFetchError";
  }
}

/** Decode an untrusted conversation-id path segment into a typed boundary error. */
function decodeConversationId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch (error) {
    // error-policy:J3 untrusted conversation path segments are client input;
    // malformed percent-encoding is a typed fetch error, not an uncaught URIError.
    throw new LocalRuntimeConversationFetchError(
      "conversation id is not valid percent-encoding",
      { cause: error },
    );
  }
}

export function createLocalRuntimeConversationFetch(
  localRuntimeOrigin: string,
  fetchImpl: typeof fetch = fetch,
): typeof fetch {
  const origin = resolveLoopbackOrigin(localRuntimeOrigin);

  return (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const sourceUrl = resolveRequestUrl(input);
    const match = CLOUD_CONVERSATION_STREAM_PATH.exec(sourceUrl.pathname);
    if (!match?.[1]) {
      throw new LocalRuntimeConversationFetchError(
        `unsupported local voice upstream path: ${sourceUrl.pathname}`,
      );
    }
    if ((init?.method ?? "GET").toUpperCase() !== "POST") {
      throw new LocalRuntimeConversationFetchError(
        "local voice conversation bridge requires POST",
      );
    }

    const conversationId = decodeConversationId(match[1]);
    const target = new URL(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages/stream`,
      origin,
    );
    const body = parseRequestBody(init?.body);
    const headers = new Headers(init?.headers);
    headers.delete("Authorization");
    headers.delete("X-Service-Key");
    headers.delete("X-Eliza-Organization-Id");
    headers.delete("X-Eliza-User-Id");
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "text/event-stream");

    return fetchImpl(target, {
      ...init,
      headers,
      body: JSON.stringify(body),
    });
  }) as typeof fetch;
}

function resolveLoopbackOrigin(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    // error-policy:J2 Configuration errors retain their parse cause so the
    // local gateway fails at startup rather than hiding a broken route.
    throw new LocalRuntimeConversationFetchError(
      "local runtime origin is not a valid URL",
      { cause: error },
    );
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    (url.hostname !== "127.0.0.1" &&
      url.hostname !== "localhost" &&
      url.hostname !== "::1")
  ) {
    throw new LocalRuntimeConversationFetchError(
      "local runtime origin must be an HTTP loopback URL",
    );
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function resolveRequestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
}

function parseRequestBody(body: BodyInit | null | undefined): {
  text: string;
  metadata: { clientTransport: typeof REALTIME_VOICE_CLIENT_TRANSPORT };
  streamProtocol: typeof VOICE_STREAM_PROTOCOL;
} {
  if (typeof body !== "string") {
    throw new LocalRuntimeConversationFetchError(
      "local voice conversation body must be JSON text",
    );
  }
  try {
    const parsed = JSON.parse(body) as {
      text?: unknown;
      metadata?: unknown;
      streamProtocol?: unknown;
    };
    if (typeof parsed.text !== "string" || parsed.text.trim() === "") {
      throw new LocalRuntimeConversationFetchError(
        "local voice conversation text is required",
      );
    }
    const metadata =
      typeof parsed.metadata === "object" &&
      parsed.metadata !== null &&
      !Array.isArray(parsed.metadata)
        ? (parsed.metadata as Record<string, unknown>)
        : null;
    if (metadata?.clientTransport !== REALTIME_VOICE_CLIENT_TRANSPORT) {
      throw new LocalRuntimeConversationFetchError(
        "local voice conversation transport metadata is required",
      );
    }
    if (parsed.streamProtocol !== VOICE_STREAM_PROTOCOL) {
      throw new LocalRuntimeConversationFetchError(
        "local voice conversation delta stream protocol is required",
      );
    }
    return {
      text: parsed.text,
      metadata: { clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT },
      streamProtocol: parsed.streamProtocol,
    };
  } catch (error) {
    // error-policy:J3 The generated upstream body crosses a transport boundary;
    // malformed input fails explicitly instead of becoming an empty chat turn.
    if (error instanceof LocalRuntimeConversationFetchError) throw error;
    throw new LocalRuntimeConversationFetchError(
      "local voice conversation body is invalid JSON",
      { cause: error },
    );
  }
}
