/**
 * Kernel-assigned port allocation for single-process e2e harnesses. Fixed
 * 364xx port constants died EADDRINUSE when the main-pipeline fan-out put two
 * harness jobs on one shared runner host (#18359); binding port 0 lets the
 * kernel hand out ports that are free right now, on any runner, with no
 * per-harness range bookkeeping. All listeners are held open concurrently so
 * every returned port is distinct, then released together for the harness's
 * own servers to claim immediately.
 *
 * Multi-process suites whose workers must independently compute the SAME port
 * (e.g. Playwright + its web server) cannot use this; they use the per-runner
 * deterministic resolver pattern in packages/homepage/scripts/e2e-port.mjs.
 */

import { createServer } from "node:net";

/**
 * Returns `count` distinct TCP ports on 127.0.0.1 that were free at the time
 * of allocation. Callers should bind them promptly; a lost race surfaces as
 * the same loud EADDRINUSE the fixed ports produced, but only against a
 * connection made in the microseconds between release and rebind.
 */
export async function allocateFreePorts(count) {
  const servers = await Promise.all(
    Array.from(
      { length: count },
      () =>
        new Promise((resolveServer, reject) => {
          const server = createServer();
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => resolveServer(server));
        }),
    ),
  );
  const ports = servers.map((server) => server.address().port);
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((resolveClose, reject) => {
          server.close((error) =>
            error ? reject(error) : resolveClose(undefined),
          );
        }),
    ),
  );
  return ports;
}
