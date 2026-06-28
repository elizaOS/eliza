// View-bundle `interact` capability handler, split out of
// ScreenshareOperatorSurface.tsx so that file exports only React components and
// stays Fast-Refresh-compatible (Vite would full-reload a component file that
// also exports a plain function). The view bundle re-exports `interact` via
// ./screenshare-view-bundle.ts.
import {
  buildViewerUrl,
  fetchJson,
  loadScreenshareTuiState,
  type PublicSession,
  type StartSessionResponse,
} from "./ScreenshareOperatorSurface.helpers";

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (capability === "terminal-screenshare-state") {
    return { viewType: "tui", ...(await loadScreenshareTuiState()) };
  }

  if (capability === "terminal-screenshare-start") {
    return {
      viewType: "tui",
      ...(await fetchJson<StartSessionResponse>(
        "/api/apps/screenshare/session",
        {
          method: "POST",
          body: JSON.stringify({
            label:
              typeof params?.label === "string" ? params.label : "Terminal",
          }),
        },
      )),
    };
  }

  if (capability === "terminal-screenshare-session") {
    const sessionId =
      typeof params?.sessionId === "string" ? params.sessionId.trim() : "";
    const token = typeof params?.token === "string" ? params.token.trim() : "";
    if (!sessionId) throw new Error("sessionId is required");
    if (!token) throw new Error("token is required");
    return {
      viewType: "tui",
      ...(await fetchJson<{ session: PublicSession }>(
        `/api/apps/screenshare/session/${encodeURIComponent(
          sessionId,
        )}?token=${encodeURIComponent(token)}`,
      )),
    };
  }

  if (capability === "terminal-screenshare-stop") {
    const sessionId =
      typeof params?.sessionId === "string" ? params.sessionId.trim() : "";
    const token = typeof params?.token === "string" ? params.token.trim() : "";
    if (!sessionId) throw new Error("sessionId is required");
    if (!token) throw new Error("token is required");
    return {
      viewType: "tui",
      ...(await fetchJson<{ session: PublicSession }>(
        `/api/apps/screenshare/session/${encodeURIComponent(sessionId)}/stop`,
        {
          method: "POST",
          body: JSON.stringify({ token }),
          headers: { "X-Screenshare-Token": token },
        },
      )),
    };
  }

  if (capability === "terminal-screenshare-input") {
    const sessionId =
      typeof params?.sessionId === "string" ? params.sessionId.trim() : "";
    const token = typeof params?.token === "string" ? params.token.trim() : "";
    if (!sessionId) throw new Error("sessionId is required");
    if (!token) throw new Error("token is required");
    return {
      viewType: "tui",
      ...(await fetchJson<Record<string, unknown>>(
        `/api/apps/screenshare/session/${encodeURIComponent(sessionId)}/input`,
        {
          method: "POST",
          body: JSON.stringify({
            token,
            type: typeof params?.type === "string" ? params.type : "keypress",
            keys: typeof params?.keys === "string" ? params.keys : undefined,
            text: typeof params?.text === "string" ? params.text : undefined,
            x: typeof params?.x === "number" ? params.x : undefined,
            y: typeof params?.y === "number" ? params.y : undefined,
            button:
              typeof params?.button === "string" ? params.button : undefined,
            deltaY:
              typeof params?.deltaY === "number" ? params.deltaY : undefined,
          }),
          headers: { "X-Screenshare-Token": token },
        },
      )),
    };
  }

  if (capability === "terminal-screenshare-viewer-url") {
    const sessionId =
      typeof params?.sessionId === "string" ? params.sessionId.trim() : "";
    const token = typeof params?.token === "string" ? params.token.trim() : "";
    if (!sessionId) throw new Error("sessionId is required");
    if (!token) throw new Error("token is required");
    return {
      viewType: "tui",
      viewerUrl: buildViewerUrl({
        baseUrl: typeof params?.baseUrl === "string" ? params.baseUrl : "",
        sessionId,
        token,
      }),
    };
  }

  throw new Error(`Unsupported capability "${capability}"`);
}
