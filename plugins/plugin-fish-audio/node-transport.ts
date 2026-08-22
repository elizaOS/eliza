/** Provides the authenticated Node WebSocket transport used by Fish Audio. */

import WebSocket from "ws";

interface FishAudioNodeTransportOptions {
  readonly headers: Record<string, string>;
}

/** Creates the production Node transport, optionally targeting a test upstream. */
export function createFishAudioNodeWebSocketFactory(endpointOverride?: string) {
  return (url: string, options: FishAudioNodeTransportOptions) =>
    new WebSocket(endpointOverride ?? url, { headers: options.headers });
}
