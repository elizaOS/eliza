/**
 * Drives LIST_CLOUD_APPS through a real ElizaCloudClient and loopback HTTP
 * server, then records how a connector delivery failure crosses the action
 * boundary.
 */

import { makeApp, makeMessage, makeRuntime } from "../../__tests__/helpers";
import { listCloudAppsAction } from "../../src/actions/list-cloud-apps";

const requests: Array<{
  path: string;
  authorization: string | null;
  apiKey: string | null;
}> = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    requests.push({
      path: url.pathname,
      authorization: request.headers.get("authorization"),
      apiKey: request.headers.get("x-api-key"),
    });
    return Response.json({
      success: true,
      apps: [makeApp({ name: "Delivered Once" })],
    });
  },
});

try {
  const runtime = makeRuntime({
    ELIZAOS_CLOUD_API_KEY: "eliza_loopback_key",
    ELIZAOS_CLOUD_BASE_URL: `http://127.0.0.1:${server.port}/api/v1`,
  });
  const delivered: string[] = [];
  const deliveryError = new Error("transport unavailable");
  let observedError: unknown;

  try {
    await listCloudAppsAction.handler(
      runtime,
      makeMessage("list my cloud apps"),
      undefined,
      undefined,
      async ({ text }) => {
        delivered.push(text);
        throw deliveryError;
      },
    );
  } catch (error) {
    observedError = error;
  }

  if (observedError !== deliveryError) {
    throw new Error(
      "Connector delivery error did not cross the action boundary",
    );
  }
  process.stdout.write(JSON.stringify({ requests, delivered }));
} finally {
  server.stop(true);
}

// The loopback listener and the SDK's keep-alive sockets can outlive
// `server.stop`, leaving the child alive long enough for the parent's
// spawnSync to look like a hang. The evidence is already flushed, so exit
// explicitly rather than waiting for the event loop to drain.
process.exit(0);
