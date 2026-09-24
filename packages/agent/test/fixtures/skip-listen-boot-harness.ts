/**
 * Boots the real API in a Bun subprocess and reports binding or configuration
 * rejection as a JSON receipt. The parent supplies the eliza-source condition
 * so workspace dependencies resolve to the revision under test.
 */

import net from "node:net";

function isPortBound(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 1000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    let settled = false;
    const finish = (bound: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(bound);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    setTimeout(() => finish(false), timeoutMs);
  });
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const port = Number(process.argv[3]);
  if (
    (mode !== "skip" && mode !== "bind" && mode !== "invalid") ||
    !Number.isInteger(port)
  ) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: "usage: <skip|bind|invalid> <port>" })}\n`,
    );
    process.exit(2);
  }

  // Route this process's own listener to the requested port so the bind-mode
  // control lands on a free, deterministic port.
  process.env.ELIZA_API_PORT = String(port);
  if (mode === "invalid") {
    process.env.CONNECTOR_HEALTH_INTERVAL_MS = "10000junk";
  }

  const { startApiServer } = await import("../../src/api/server.ts");
  if (mode === "invalid") {
    try {
      await startApiServer({ port, initialAgentState: "starting" });
    } catch (err) {
      const bound = await isPortBound(port);
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          mode,
          port,
          bound,
          rejected: true,
          error: err instanceof Error ? err.message : String(err),
        })}\n`,
      );
      process.exit(0);
    }
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: "invalid interval was accepted" })}\n`,
    );
    process.exit(1);
  }
  const server = await startApiServer({
    port,
    skipListen: mode === "skip",
    initialAgentState: "starting",
  });

  const bound = await isPortBound(server.port);
  process.stdout.write(
    `${JSON.stringify({ ok: true, mode, port: server.port, bound })}\n`,
  );

  await server.close();
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
