/**
 * Dev stack snapshot for tools and agents (Cursor, scripts).
 *
 * **Why this module:** IDEs do not auto-discover localhost. A single JSON shape from
 * `GET /api/dev/stack` gives ports, renderer URL, and which optional hooks (console tail) are
 * configured — without scraping terminal output or launcher logs.
 *
 * The API handler may override `api.listenPort` / `api.baseUrl` from the bound socket so the JSON
 * matches the **accepted** TCP port (WHY: env can lag or describe intent; the socket is
 * authoritative when the request hits this server).
 */
import {
  resolveDesktopApiPort,
  resolveDesktopUiPort,
} from "@elizaos/host/protocol";
import { isAllowedDevConsoleLogPath } from "./dev-console-log";
export const ELIZA_DEV_STACK_SCHEMA = "elizaos.dev.stack/v1" as const;
export type DevStackPayload = {
  schema: typeof ELIZA_DEV_STACK_SCHEMA;
  api: {
    /** Intended listen port (from ELIZA_API_PORT / ELIZA_PORT). */
    listenPort: number;
    baseUrl: string;
  };
  desktop: {
    /** Vite or static renderer URL when desktop dev set ELIZA_RENDERER_URL. */
    rendererUrl: string | null;
    /** Dashboard UI port when ELIZA_PORT is set (desktop / Vite). */
    uiPort: number | null;
    /** API base named by ELIZA_DESKTOP_API_BASE, when set. */
    desktopApiBase: string | null;
  };
  /** Aggregated dev child logs when ELIZA_DESKTOP_DEV_LOG_PATH names a log file. */
  desktopDevLog: {
    filePath: string | null;
    apiTailPath: string | null;
  };
  hints: string[];
};
/**
 * Build the JSON body for `GET /api/dev/stack`.
 */
export function resolveDevStackFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DevStackPayload {
  const apiPort = resolveDesktopApiPort(env);
  // Delegate to the canonical UI-port resolver so /api/dev/stack reports the
  // same uiPort clients actually use. The previous inline ELIZA_PORT fallback
  // conflated the server/API-only port with the UI port.
  const uiPort = resolveDesktopUiPort(env);
  const rendererUrl = env.ELIZA_RENDERER_URL?.trim() || null;
  const desktopApiBase = env.ELIZA_DESKTOP_API_BASE?.trim() || null;
  const configuredDevLogPath = env.ELIZA_DESKTOP_DEV_LOG_PATH?.trim() || null;
  const devLogPathAllowed =
    configuredDevLogPath !== null &&
    isAllowedDevConsoleLogPath(configuredDevLogPath);
  return {
    schema: ELIZA_DEV_STACK_SCHEMA,
    api: {
      listenPort: apiPort,
      baseUrl: `http://127.0.0.1:${apiPort}`,
    },
    desktop: {
      rendererUrl,
      uiPort,
      desktopApiBase,
    },
    desktopDevLog: {
      filePath: configuredDevLogPath,
      apiTailPath: devLogPathAllowed ? "/api/dev/console-log" : null,
    },
    hints: [
      "Aggregated dev log lines: GET /api/dev/console-log?maxLines=400&maxBytes=256000 (loopback) or read desktopDevLog.filePath.",
      "Voice-loop latency traces + per-stage p50/p90/p99 histograms: GET /api/dev/voice-latency?limit=50 (loopback), or `bun run --cwd packages/app voice:latency-report` for a printed table.",
      "Boot phase timings, memory growth, and the exact error for any plugin that failed to load: GET /api/dev/boot-history (loopback). latestBoot:null = boot has not completed since process start (restart storm/crash); watch:true = API is running under an active dev watcher.",
    ],
  };
}
