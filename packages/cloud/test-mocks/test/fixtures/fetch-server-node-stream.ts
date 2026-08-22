/** Runs the Node fallback HTTP adapter for subprocess streaming and cancellation proof. */

import { startFetchServer } from "../../src/fetch-server.ts";

const encoder = new TextEncoder();
const server = await startFetchServer(
  (request) => {
    if (new URL(request.url).pathname === "/throw") {
      throw new Error("NODE_ADAPTER_SECRET_do-not-reflect_9e37");
    }
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("first\n"));
          const timer = setTimeout(() => {
            controller.enqueue(encoder.encode("second\n"));
            controller.close();
          }, 1_000);
          request.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              process.stdout.write("aborted\n");
              controller.error(request.signal.reason);
            },
            { once: true },
          );
        },
      }),
      { headers: { "content-type": "text/plain" } },
    );
  },
  { hostname: "127.0.0.1", port: 0 },
);

process.stdout.write(`${server.port}\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await server.stop();
    process.exit(0);
  });
}
