/**
 * Dev stack snapshot for tools and agents (Cursor, scripts).
 *
 * **Why this module:** IDEs do not auto-discover localhost or the Electrobun window. A single JSON
 * shape from `GET /api/dev/stack` gives ports, renderer URL, and which optional hooks (screenshot,
 * console tail) are configured — without scraping terminal output or launcher logs.
 *
 * Env is set by `eliza/packages/app-core/scripts/dev-platform.mjs` when using `dev:desktop` / `dev:desktop:watch`; the API
 * handler may override `api.listenPort` / `api.baseUrl` from the bound socket so the JSON matches
 * the **accepted** TCP port (WHY: env can lag or describe intent; the socket is authoritative when
 * the request hits this server). Orchestrator-side `allocate-loopback-port` reduces mismatch for
 * desktop dev; embedded Electrobun also syncs env after bind.
 */
export declare const ELIZA_DEV_STACK_SCHEMA: "elizaos.dev.stack/v1";
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
        /** Same base the Electrobun shell uses for API calls, when set. */
        desktopApiBase: string | null;
    };
    /**
     * When desktop dev enables ELIZA_DESKTOP_SCREENSHOT_SERVER, the API proxies
     * a PNG from Electrobun (`GET …/api/dev/cursor-screenshot`, loopback only).
     */
    cursorScreenshot: {
        available: boolean;
        path: string | null;
    };
    /** Aggregated desktop dev child logs when dev-platform writes ELIZA_DESKTOP_DEV_LOG_PATH. */
    desktopDevLog: {
        filePath: string | null;
        apiTailPath: string | null;
    };
    hints: string[];
};
/**
 * Build the JSON body for `GET /api/dev/stack`.
 */
export declare function resolveDevStackFromEnv(env?: NodeJS.ProcessEnv): DevStackPayload;
//# sourceMappingURL=dev-stack.d.ts.map