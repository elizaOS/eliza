/**
 * Forward the incoming Worker request to another path on the same origin.
 * Used for legacy path aliases (e.g. /api/elevenlabs/tts → /api/v1/voice/tts).
 */

import type { AppContext } from "@/types/cloud-worker-env";

export function forwardSameOriginRequest(c: AppContext, pathname: string): Promise<Response> {
  const nextUrl = new URL(c.req.url);
  nextUrl.pathname = pathname;
  return fetch(new Request(nextUrl, c.req.raw));
}
