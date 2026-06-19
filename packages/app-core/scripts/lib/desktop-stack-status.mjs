/**
 * Local Eliza desktop dev stack probes (API + UI ports).
 * Used by `eliza/packages/app-core/scripts/desktop-stack-status.mjs` and tests.
 *
 * **Why fetch `/api/dev/stack` after port checks:** env in the agent shell may omit `ELIZA_PORT`;
 * the API process (spawned by dev-platform) carries the canonical desktop env and returns `uiPort`
 * and hook flags for screenshot / console log.
 */

import { createConnection } from "node:net";

const DEFAULT_UI_PORT = 2138;
const DEFAULT_API_PORT = 2138;
const CONNECT_TIMEOUT_MS = 800;
const FETCH_TIMEOUT_MS = 2500;

function parsePositivePort(value) {
  if (!value) return NaN;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536
    ? parsed
    : NaN;
}

function resolveDesktopApiPort(env) {
  return (
    parsePositivePort(env.ELIZA_API_PORT) ||
    parsePositivePort(env.ELIZA_PORT) ||
    DEFAULT_API_PORT
  );
}

/**
 * @param {number} port
 * @param {string} [host]
 * @returns {Promise<boolean>}
 */
export function isPortOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host }, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * @param {string} url
 * @param {typeof fetch} [fetchImpl]
 */
export async function fetchJsonOk(url, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
    return {
      ok: res.ok,
      status: res.status,
      json,
      bodyPreview: text.length > 400 ? `${text.slice(0, 400)}…` : text,
    };
  } catch (e) {
    const err = /** @type {Error} */ (e);
    return {
      ok: false,
      status: 0,
      json: null,
      bodyPreview: "",
      error:
        err?.name === "AbortError" ? "timeout" : String(err?.message ?? err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {typeof fetch} [fetchImpl]
 * @param {{ isPortOpen?: (port: number, host?: string) => Promise<boolean> }} [deps]
 *     `isPortOpen` override for tests (same-module lexical calls ignore vi.spyOn).
 */
export async function gatherDesktopStackStatus(
  env = process.env,
  fetchImpl,
  deps,
) {
  const checkPort = deps?.isPortOpen ?? isPortOpen;
  const apiPort = resolveDesktopApiPort(env);
  const fetchFn = fetchImpl ?? globalThis.fetch;
  const apiBase = `http://127.0.0.1:${apiPort}`;

  const apiListening = await checkPort(apiPort);

  let devStack = null;
  if (apiListening) {
    const ds = await fetchJsonOk(`${apiBase}/api/dev/stack`, fetchFn);
    if (ds.ok && ds.json && typeof ds.json === "object") {
      devStack = ds.json;
    }
  }

  const uiFromEnv = parsePositivePort(env.ELIZA_PORT);
  const uiFromApi =
    devStack?.desktop &&
    typeof devStack.desktop.uiPort === "number" &&
    devStack.desktop.uiPort > 0
      ? devStack.desktop.uiPort
      : NaN;
  const uiPort =
    (Number.isFinite(uiFromEnv) ? uiFromEnv : NaN) ||
    (Number.isFinite(uiFromApi) ? uiFromApi : NaN) ||
    DEFAULT_UI_PORT;

  const uiListening = await checkPort(uiPort);

  const health = await fetchJsonOk(`${apiBase}/api/health`, fetchFn);
  const status = await fetchJsonOk(`${apiBase}/api/status`, fetchFn);

  return {
    uiPort,
    apiPort,
    uiListening,
    apiListening,
    devStack,
    apiHealth: health,
    apiStatus: status,
    hints: {
      devCommands: ["bun run dev:desktop", "bun run dev:desktop:watch"],
      docsPath: "docs/apps/desktop-local-development.md",
      agentNote:
        "The native Electrobun window is not visible to the agent. Prefer GET /api/dev/stack on the API for canonical rendererUrl and ports; use Browser MCP on desktop.rendererUrl when native bridges are not required.",
    },
  };
}
