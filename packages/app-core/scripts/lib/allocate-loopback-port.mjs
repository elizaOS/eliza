/**
 * Pick a free loopback TCP port starting at `preferred` (inclusive).
 *
 * **Why a sibling of `loopback-port.ts`:** `dev-platform.mjs` runs under Node,
 * not Bun, but the algorithm must match the Electrobun shell: find the first
 * bindable 127.0.0.1 port in a range.
 *
 * **Why the orchestrator allocates before spawn:** Vite reads `vite.config.ts`
 * once; its `/api` proxy target must equal the API listen port **at Vite
 * startup**. If only `dev-server.ts` shifted ports internally, the UI would
 * proxy to a stale default until Vite restarted. Resolving here keeps
 * `ELIZA_API_PORT`, `ELIZA_DESKTOP_API_BASE`, `ELIZA_RENDERER_URL`, and
 * `ELIZA_PORT` (Vite) consistent across all children.
 */

import { createServer } from "node:net";

/**
 * @param {number} port
 * @param {string} [host]
 * @returns {Promise<boolean>}
 */
function tryBindPort(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = createServer();
    const onErr = () => {
      server.removeAllListeners();
      resolve(false);
    };
    server.once("error", onErr);
    server.listen({ port, host }, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * @param {number} preferred
 * @param {{ maxHops?: number, host?: string }} [opts]
 * @returns {Promise<number>}
 */
export async function allocateFirstFreeLoopbackPort(preferred, opts = {}) {
  const host = opts.host ?? "127.0.0.1";
  const maxHops = opts.maxHops ?? 64;
  if (!Number.isFinite(preferred) || preferred < 1 || preferred > 65535) {
    throw new Error(`Invalid preferred port: ${preferred}`);
  }
  for (let i = 0; i < maxHops; i++) {
    const port = preferred + i;
    if (port > 65535) break;
    if (await tryBindPort(port, host)) {
      return port;
    }
  }
  throw new Error(
    `No free TCP port on ${host} in range ${preferred}–${preferred + maxHops - 1}`,
  );
}
