/**
 * Subprocess harness for the dedicated-agent stream CORS preflight regression.
 *
 * The agent vitest lane cannot import `server.ts` in-process, but a plain Bun
 * subprocess can boot the real HTTP server. This fixture starts that server,
 * sends the browser preflight that native Capacitor chat streaming emits, and
 * reports the wire response as JSON for the parent test to assert.
 */

async function main(): Promise<void> {
  const port = Number(process.argv[2]);
  if (!Number.isInteger(port) || port <= 0) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: "usage: <port>" })}\n`,
    );
    process.exit(2);
  }

  process.env.ELIZA_API_PORT = String(port);

  const { startApiServer } = await import("../server.ts");
  const server = await startApiServer({
    port,
    initialAgentState: "starting",
    skipDeferredStartupWork: true,
  });

  try {
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/conversations/conv-1/messages/stream`,
      {
        method: "OPTIONS",
        headers: {
          origin: "https://localhost",
          "access-control-request-method": "POST",
          "access-control-request-headers":
            "authorization,content-type,x-elizaos-client-id",
        },
      },
    );

    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        status: response.status,
        allowOrigin: response.headers.get("access-control-allow-origin"),
        allowMethods: response.headers.get("access-control-allow-methods"),
        allowHeaders: response.headers.get("access-control-allow-headers"),
      })}\n`,
    );
  } finally {
    await server.close();
  }

  process.exit(0);
}

main().catch((err: unknown) => {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })}\n`,
  );
  process.exit(1);
});
