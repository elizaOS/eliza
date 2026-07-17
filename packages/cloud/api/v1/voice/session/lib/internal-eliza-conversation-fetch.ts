/**
 * In-process fetch adapter for realtime voice turns that target the canonical
 * Eliza conversation SSE route. The voice bridge keeps its HTTP-shaped contract
 * for tests and future transports, but Worker production dispatches the scoped
 * request directly into the route module so same-host public fetch behavior
 * cannot bypass this Worker.
 */
import { Hono } from "hono";
import type { AppEnv, Bindings } from "@/types/cloud-worker-env";
import conversationStreamRoute from "../../../eliza/agents/[agentId]/api/conversations/[conversationId]/messages/stream/route";

const CANONICAL_STREAM_ROUTE =
  "/api/v1/eliza/agents/:agentId/api/conversations/:conversationId/messages/stream";

export interface InternalElizaConversationFetchClaims {
  agentId: string;
  conversationId: string;
}

export function createInternalElizaConversationFetch(
  env: Bindings,
  claims: InternalElizaConversationFetchClaims,
): typeof fetch {
  const app = new Hono<AppEnv>().route(
    CANONICAL_STREAM_ROUTE,
    conversationStreamRoute,
  );

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assertCanonicalVoiceStreamPath(url, claims);
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.text();

    return app.request(
      `${url.pathname}${url.search}`,
      {
        method: request.method,
        headers: request.headers,
        body,
        signal: request.signal,
      },
      env,
    );
  }) as typeof fetch;
}

function assertCanonicalVoiceStreamPath(
  url: URL,
  claims: InternalElizaConversationFetchClaims,
): void {
  const match = url.pathname.match(
    /^\/api\/v1\/eliza\/agents\/([^/]+)\/api\/conversations\/([^/]+)\/messages\/stream$/,
  );
  if (!match) {
    throw new TypeError(
      `unsupported internal Eliza stream path: ${url.pathname}`,
    );
  }
  const agentId = decodeURIComponent(match[1]);
  const conversationId = decodeURIComponent(match[2]);
  if (agentId !== claims.agentId || conversationId !== claims.conversationId) {
    throw new TypeError(
      "internal Eliza stream path does not match session scope",
    );
  }
}
