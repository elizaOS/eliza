import type http from "node:http";
import {
  captureDesktopScreenshot,
  type DesktopInputButton,
  type DesktopScreenshotRegion,
  listDesktopWindows,
  performDesktopClick,
  performDesktopDoubleClick,
  performDesktopKeypress,
  performDesktopMouseMove,
  performDesktopScroll,
  performDesktopTextInput,
} from "@elizaos/agent";
import type {
  AppLaunchDiagnostic,
  AppLaunchPreparation,
  AppLaunchSessionContext,
  AppRunSessionContext,
  AppSessionState,
} from "@elizaos/shared";
import {
  buildScreenshareAppSession,
  canAccessScreenshareSession,
  createScreenshareSession,
  getOrCreateLocalScreenshareSession,
  getScreenshareCapabilities,
  getScreenshareSession,
  listScreenshareSessions,
  recordScreenshareFrame,
  recordScreenshareInput,
  type ScreenshareSession,
  stopScreenshareSession,
  toPublicSession,
} from "./session-store.js";

type RouteJson = (response: unknown, data: unknown, status?: number) => void;
type RouteError = (response: unknown, message: string, status?: number) => void;

interface RouteContext {
  method: string;
  pathname: string;
  url: URL;
  req?: http.IncomingMessage;
  res: unknown;
  runtime: unknown | null;
  json: RouteJson;
  error: RouteError;
  readJsonBody: <
    T extends object = Record<string, unknown>,
  >() => Promise<T | null>;
}

interface StartSessionBody {
  label?: unknown;
}

interface ScreenshareInputBody {
  token?: unknown;
  type?: unknown;
  x?: unknown;
  y?: unknown;
  button?: unknown;
  text?: unknown;
  keys?: unknown;
  deltaX?: unknown;
  deltaY?: unknown;
}

const BASE_PATH = "/api/apps/screenshare";
const VIEWER_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-pointer-lock";
const MAX_TEXT_INPUT_LENGTH = 4096;

// Simple in-process rate limiter for session-creation requests.
const SESSION_CREATE_LIMIT = 10; // max requests per window
const SESSION_CREATE_WINDOW_MS = 60_000; // 1 minute
const sessionCreateCounts = new Map<
  string,
  { count: number; resetAt: number }
>();

function getRemoteIp(req: http.IncomingMessage | undefined): string {
  const addr = req?.socket?.remoteAddress ?? req?.headers?.["x-forwarded-for"];
  return (Array.isArray(addr) ? addr[0] : (addr ?? "unknown"))
    .split(",")[0]
    .trim();
}

function sessionCreateRateLimitExceeded(
  req: http.IncomingMessage | undefined,
): boolean {
  const ip = getRemoteIp(req);
  const now = Date.now();
  const entry = sessionCreateCounts.get(ip);
  if (!entry || entry.resetAt <= now) {
    sessionCreateCounts.set(ip, {
      count: 1,
      resetAt: now + SESSION_CREATE_WINDOW_MS,
    });
    return false;
  }
  entry.count += 1;
  return entry.count > SESSION_CREATE_LIMIT;
}
const MAX_KEYPRESS_LENGTH = 128;
const SAFE_KEYPRESS_PATTERN = /^[A-Za-z0-9+_.,: -]+$/;

export async function prepareLaunch(
  _ctx: AppLaunchSessionContext,
): Promise<AppLaunchPreparation> {
  const session = getOrCreateLocalScreenshareSession();
  const viewerUrl = buildViewerUrl(session);
  return {
    launchUrl: viewerUrl,
    viewer: {
      url: viewerUrl,
      sandbox: VIEWER_SANDBOX,
    },
    skipRuntimePluginRegistration: true,
    diagnostics: collectCapabilityDiagnostics(),
  };
}

export async function resolveLaunchSession(
  _ctx: AppLaunchSessionContext,
): Promise<AppSessionState> {
  return buildScreenshareAppSession(getOrCreateLocalScreenshareSession());
}

export async function refreshRunSession(
  ctx: AppRunSessionContext,
): Promise<AppSessionState | null> {
  const sessionId = ctx.session?.sessionId;
  if (!sessionId) {
    return buildScreenshareAppSession(getOrCreateLocalScreenshareSession());
  }
  const session = getScreenshareSession(sessionId);
  if (!session || session.status !== "active") {
    return null;
  }
  return buildScreenshareAppSession(session);
}

export async function stopRun(ctx: AppRunSessionContext): Promise<void> {
  const sessionId = ctx.session?.sessionId;
  if (sessionId) {
    stopScreenshareSession(sessionId);
  }
}

export async function handleAppRoutes(ctx: RouteContext): Promise<boolean> {
  if (!ctx.pathname.startsWith(BASE_PATH)) {
    return false;
  }

  if (ctx.method === "GET" && ctx.pathname === `${BASE_PATH}/viewer`) {
    sendHtml(ctx.res, renderViewerHtml());
    return true;
  }

  if (ctx.method === "GET" && ctx.pathname === `${BASE_PATH}/capabilities`) {
    ctx.json(ctx.res, {
      platform: process.platform,
      capabilities: getScreenshareCapabilities(),
    });
    return true;
  }

  if (ctx.method === "GET" && ctx.pathname === `${BASE_PATH}/windows`) {
    try {
      ctx.json(ctx.res, { windows: listDesktopWindows() });
    } catch (error) {
      ctx.error(
        ctx.res,
        error instanceof Error
          ? error.message
          : "Desktop window listing failed.",
        500,
      );
    }
    return true;
  }

  if (ctx.method === "GET" && ctx.pathname === `${BASE_PATH}/sessions`) {
    ctx.json(ctx.res, { sessions: listScreenshareSessions() });
    return true;
  }

  if (ctx.method === "POST" && ctx.pathname === `${BASE_PATH}/session`) {
    if (sessionCreateRateLimitExceeded(ctx.req)) {
      ctx.error(
        ctx.res,
        "Too many session creation requests. Please wait before trying again.",
        429,
      );
      return true;
    }
    const body = await ctx.readJsonBody<StartSessionBody>();
    if (body === null) {
      return true;
    }
    const session = createScreenshareSession(readLabel(body.label));
    ctx.json(ctx.res, {
      session: toPublicSession(session),
      token: session.token,
      viewerUrl: buildViewerUrl(session),
    });
    return true;
  }

  const match = ctx.pathname.match(
    /^\/api\/apps\/screenshare\/session\/([^/]+)(?:\/([^/]+))?$/,
  );
  if (!match?.[1]) {
    return false;
  }

  const sessionId = decodeURIComponent(match[1]);
  const subroute = match[2] ? decodeURIComponent(match[2]) : "";
  const session = getScreenshareSession(sessionId);
  if (!session) {
    ctx.error(
      ctx.res,
      `Screen share session "${sessionId}" was not found.`,
      404,
    );
    return true;
  }

  if (ctx.method === "GET" && !subroute) {
    const token = readRequestToken(ctx);
    if (!canAccessScreenshareSession(session, token)) {
      ctx.error(ctx.res, "Invalid screen share token.", 403);
      return true;
    }
    ctx.json(ctx.res, { session: toPublicSession(session) });
    return true;
  }

  if (ctx.method === "GET" && subroute === "frame") {
    const token = readRequestToken(ctx);
    if (!canAccessScreenshareSession(session, token)) {
      ctx.error(ctx.res, "Invalid screen share token.", 403);
      return true;
    }
    if (session.status !== "active") {
      ctx.error(ctx.res, "Screen share session is stopped.", 409);
      return true;
    }
    const region = readFrameRegion(ctx.url);
    try {
      const screenshot = captureDesktopScreenshot(region);
      recordScreenshareFrame(session.id);
      sendPng(ctx.res, screenshot);
    } catch (error) {
      ctx.error(
        ctx.res,
        error instanceof Error ? error.message : "Screenshot failed.",
        500,
      );
    }
    return true;
  }

  if (ctx.method === "POST" && subroute === "input") {
    const body = await ctx.readJsonBody<ScreenshareInputBody>();
    if (body === null) {
      return true;
    }
    const token = readBodyToken(body) ?? readRequestToken(ctx);
    if (!canAccessScreenshareSession(session, token)) {
      ctx.error(ctx.res, "Invalid screen share token.", 403);
      return true;
    }
    if (session.status !== "active") {
      ctx.error(ctx.res, "Screen share session is stopped.", 409);
      return true;
    }

    let result: { success: boolean; message: string };
    try {
      result = executeInput(body);
    } catch (error) {
      ctx.error(
        ctx.res,
        error instanceof Error ? error.message : "Desktop input failed.",
        500,
      );
      return true;
    }
    if (!result.success) {
      ctx.error(ctx.res, result.message, 400);
      return true;
    }
    const updated = recordScreenshareInput(session.id) ?? session;
    ctx.json(ctx.res, {
      success: true,
      message: result.message,
      session: toPublicSession(updated),
    });
    return true;
  }

  if (ctx.method === "POST" && subroute === "stop") {
    const body = await ctx.readJsonBody<{ token?: unknown }>();
    if (body === null) {
      return true;
    }
    const token = readBodyToken(body) ?? readRequestToken(ctx);
    if (!canAccessScreenshareSession(session, token)) {
      ctx.error(ctx.res, "Invalid screen share token.", 403);
      return true;
    }
    const stopped = stopScreenshareSession(session.id) ?? session;
    ctx.json(ctx.res, { session: toPublicSession(stopped) });
    return true;
  }

  return false;
}

function collectCapabilityDiagnostics(): AppLaunchDiagnostic[] {
  const capabilities = getScreenshareCapabilities();
  return Object.entries(capabilities)
    .filter(([, capability]) => !capability.available)
    .map(([code, capability]) => ({
      code: `screenshare-${code}-unavailable`,
      severity: "warning" as const,
      message: `${code} unavailable: ${capability.tool}`,
    }));
}

function buildViewerUrl(session: ScreenshareSession): string {
  const params = new URLSearchParams({
    sessionId: session.id,
    token: session.token,
    mode: "host",
  });
  return `${BASE_PATH}/viewer?${params.toString()}`;
}

function readLabel(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 80)
    : "This machine";
}

function readRequestToken(ctx: RouteContext): string | null {
  const queryToken = ctx.url.searchParams.get("token");
  if (queryToken?.trim()) {
    return queryToken.trim();
  }

  const req = ctx.req;
  const headerToken = req?.headers["x-screenshare-token"];
  if (typeof headerToken === "string" && headerToken.trim()) {
    return headerToken.trim();
  }

  const authorization = req?.headers.authorization;
  if (typeof authorization === "string") {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    const token = match?.[1]?.trim();
    if (token) {
      return token;
    }
  }

  return null;
}

function readBodyToken(body: { token?: unknown }): string | null {
  return typeof body.token === "string" && body.token.trim()
    ? body.token.trim()
    : null;
}

function readFrameRegion(url: URL): DesktopScreenshotRegion | undefined {
  const x = readIntegerParam(url, "x");
  const y = readIntegerParam(url, "y");
  const width = readIntegerParam(url, "width");
  const height = readIntegerParam(url, "height");
  if (x === null || y === null || width === null || height === null) {
    return undefined;
  }
  if (width <= 0 || height <= 0) {
    return undefined;
  }
  return { x, y, width, height };
}

function readIntegerParam(url: URL, key: string): number | null {
  const raw = url.searchParams.get(key);
  if (raw === null || raw.trim() === "") {
    return null;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : null;
}

function executeInput(body: ScreenshareInputBody): {
  success: boolean;
  message: string;
} {
  const type = typeof body.type === "string" ? body.type.trim() : "";
  if (type === "click" || type === "double-click" || type === "move") {
    const point = readPoint(body);
    if (!point) {
      return { success: false, message: "Input requires integer x and y." };
    }
    if (type === "move") {
      performDesktopMouseMove(point.x, point.y);
      return { success: true, message: "Pointer moved." };
    }
    const button = readButton(body.button);
    if (!button) {
      return { success: false, message: "button must be left or right." };
    }
    if (type === "double-click") {
      performDesktopDoubleClick(point.x, point.y, button);
      return { success: true, message: "Double-click sent." };
    }
    performDesktopClick(point.x, point.y, button);
    return { success: true, message: "Click sent." };
  }

  if (type === "type") {
    if (typeof body.text !== "string" || body.text.length === 0) {
      return { success: false, message: "text is required." };
    }
    if (body.text.length > MAX_TEXT_INPUT_LENGTH) {
      return {
        success: false,
        message: `text exceeds maximum length (${MAX_TEXT_INPUT_LENGTH}).`,
      };
    }
    performDesktopTextInput(body.text);
    return { success: true, message: "Text sent." };
  }

  if (type === "keypress") {
    if (typeof body.keys !== "string" || !body.keys.trim()) {
      return { success: false, message: "keys is required." };
    }
    const keys = body.keys.trim();
    if (keys.length > MAX_KEYPRESS_LENGTH) {
      return {
        success: false,
        message: `keys exceeds maximum length (${MAX_KEYPRESS_LENGTH}).`,
      };
    }
    if (!SAFE_KEYPRESS_PATTERN.test(keys)) {
      return {
        success: false,
        message:
          "keys contains unsupported characters; allowed: letters, numbers, space, +, _, ., ,, :, -",
      };
    }
    performDesktopKeypress(keys);
    return { success: true, message: "Keypress sent." };
  }

  if (type === "scroll") {
    const deltaX = readInteger(body.deltaX) ?? 0;
    const deltaY = readInteger(body.deltaY) ?? 0;
    performDesktopScroll(deltaX, deltaY);
    return { success: true, message: "Scroll sent." };
  }

  return {
    success: false,
    message:
      "type must be one of: click, double-click, move, type, keypress, scroll.",
  };
}

function readPoint(
  body: ScreenshareInputBody,
): { x: number; y: number } | null {
  const x = readInteger(body.x);
  const y = readInteger(body.y);
  return x === null || y === null ? null : { x, y };
}

function readInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function readButton(value: unknown): DesktopInputButton | null {
  if (value === undefined || value === null || value === "left") {
    return "left";
  }
  return value === "right" ? "right" : null;
}

function sendPng(response: unknown, png: Buffer): void {
  const res = response as http.ServerResponse;
  res.writeHead(200, {
    "Content-Type": "image/png",
    "Content-Length": png.byteLength,
    "Cache-Control": "no-store",
  });
  res.end(png);
}

function sendHtml(response: unknown, html: string): void {
  const data = Buffer.from(html, "utf8");
  const res = response as http.ServerResponse;
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": data.byteLength,
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function renderViewerHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Screen Share</title>
<style>
:root{color-scheme:dark;--bg:#0b0d0f;--panel:#15181c;--line:#2a3036;--txt:#edf1f4;--muted:#9aa7ae;--accent:#d4b45e;--ok:#70d6a7;--danger:#f17a7a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:13px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{display:grid;grid-template-rows:auto 1fr auto;min-height:100vh}
.bar{display:flex;gap:10px;align-items:center;border-bottom:1px solid var(--line);background:var(--panel);padding:10px 12px}
.status{display:inline-flex;align-items:center;gap:8px;min-width:0;white-space:nowrap}.dot{width:8px;height:8px;border-radius:999px;background:var(--muted)}.dot.live{background:var(--ok)}.dot.err{background:var(--danger)}
.spacer{flex:1}.btn,.input{height:32px;border:1px solid var(--line);border-radius:8px;background:#0f1215;color:var(--txt);padding:0 10px}.btn{cursor:pointer}.btn:hover{border-color:var(--accent)}.btn:disabled{cursor:not-allowed;opacity:.55}.input{min-width:0}
.stage{display:grid;place-items:center;min-height:0;background:#050607;overflow:hidden;position:relative}.frame{max-width:100%;max-height:100%;object-fit:contain;user-select:none;outline:none}.empty{color:var(--muted);text-align:center;padding:24px}
.controls{display:grid;grid-template-columns:1fr auto auto auto;gap:8px;border-top:1px solid var(--line);background:var(--panel);padding:10px 12px}.keys{display:flex;gap:8px;min-width:0}
@media(max-width:720px){.bar,.controls{grid-template-columns:1fr;flex-wrap:wrap}.controls{display:flex}.keys{width:100%}.input{flex:1}}
</style>
</head>
<body>
<main>
  <div class="bar">
    <div class="status"><span id="dot" class="dot"></span><span id="status">Connecting</span></div>
    <div class="spacer"></div>
    <input id="base" class="input" placeholder="Server URL" />
    <input id="session" class="input" placeholder="Session" />
    <input id="token" class="input" placeholder="Token" />
    <button id="connect" class="btn" type="button">Connect</button>
  </div>
  <div id="stage" class="stage" tabindex="0">
    <img id="frame" class="frame" alt="Remote desktop stream" draggable="false" />
    <div id="empty" class="empty">No stream selected.</div>
  </div>
  <div class="controls">
    <div class="keys">
      <input id="text" class="input" placeholder="Text" />
      <button id="type" class="btn" type="button">Type</button>
    </div>
    <button class="btn" data-key="Enter" type="button">Enter</button>
    <button class="btn" data-key="Escape" type="button">Esc</button>
    <button id="stop" class="btn" type="button">Stop</button>
  </div>
</main>
<script>
(() => {
  const params = new URLSearchParams(location.search);
  const state = {
    base: params.get("remoteBase") || "",
    sessionId: params.get("sessionId") || "",
    token: params.get("token") || "",
    running: false,
    timer: 0,
    frameObjectUrl: ""
  };
  const dot = document.getElementById("dot");
  const status = document.getElementById("status");
  const frame = document.getElementById("frame");
  const empty = document.getElementById("empty");
  const stage = document.getElementById("stage");
  const base = document.getElementById("base");
  const session = document.getElementById("session");
  const token = document.getElementById("token");
  const text = document.getElementById("text");
  base.value = state.base;
  session.value = state.sessionId;
  token.value = state.token;

  function endpoint(path) {
    const root = state.base.replace(/\\/$/, "");
    return root + path;
  }

  function setStatus(label, tone) {
    status.textContent = label;
    dot.className = "dot" + (tone === "live" ? " live" : tone === "err" ? " err" : "");
  }

  function applyConnection() {
    state.base = base.value.trim();
    state.sessionId = session.value.trim();
    state.token = token.value.trim();
    state.running = Boolean(state.sessionId && state.token);
    empty.style.display = state.running ? "none" : "block";
    frame.style.display = state.running ? "block" : "none";
    clearTimeout(state.timer);
    if (state.running) {
      setStatus("Streaming", "live");
      loadFrame();
    } else {
      setStatus("Idle", "");
    }
  }

  function disconnect(label) {
    state.running = false;
    clearTimeout(state.timer);
    if (state.frameObjectUrl) {
      URL.revokeObjectURL(state.frameObjectUrl);
      state.frameObjectUrl = "";
    }
    frame.removeAttribute("src");
    frame.style.display = "none";
    empty.style.display = "block";
    setStatus(label, "");
  }

  async function readErrorMessage(response) {
    const body = await response.clone().json().catch(() => null);
    if (body && typeof body.error === "string" && body.error.trim()) {
      return body.error.trim();
    }
    const text = await response.text().catch(() => "");
    return text.trim() || "Frame unavailable";
  }

  async function loadFrame() {
    if (!state.running) return;
    const src = endpoint("/api/apps/screenshare/session/" + encodeURIComponent(state.sessionId) + "/frame?token=" + encodeURIComponent(state.token) + "&t=" + Date.now());
    try {
      const response = await fetch(src, {
        headers: { "X-Screenshare-Token": state.token }
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }
      const blob = await response.blob();
      if (!state.running) return;
      if (state.frameObjectUrl) {
        URL.revokeObjectURL(state.frameObjectUrl);
      }
      state.frameObjectUrl = URL.createObjectURL(blob);
      frame.src = state.frameObjectUrl;
      setStatus("Streaming", "live");
      state.timer = window.setTimeout(loadFrame, 500);
    } catch (err) {
      if (!state.running) return;
      setStatus(err instanceof Error ? err.message : "Frame unavailable", "err");
      state.timer = window.setTimeout(loadFrame, 1500);
    }
  }

  async function sendInput(payload) {
    if (!state.sessionId || !state.token) return;
    const response = await fetch(endpoint("/api/apps/screenshare/session/" + encodeURIComponent(state.sessionId) + "/input"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Screenshare-Token": state.token },
      body: JSON.stringify({ ...payload, token: state.token })
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.error || body?.message || "Input failed");
    }
  }

  function imagePoint(event) {
    const rect = frame.getBoundingClientRect();
    if (!frame.naturalWidth || !frame.naturalHeight || rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.round((event.clientX - rect.left) * frame.naturalWidth / rect.width),
      y: Math.round((event.clientY - rect.top) * frame.naturalHeight / rect.height)
    };
  }

  frame.addEventListener("click", (event) => {
    const point = imagePoint(event);
    if (!point) return;
    stage.focus();
    void sendInput({ type: "click", ...point, button: "left" }).catch((err) => setStatus(err.message, "err"));
  });
  frame.addEventListener("dblclick", (event) => {
    const point = imagePoint(event);
    if (!point) return;
    stage.focus();
    void sendInput({ type: "double-click", ...point, button: "left" }).catch((err) => setStatus(err.message, "err"));
  });
  frame.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const point = imagePoint(event);
    if (!point) return;
    stage.focus();
    void sendInput({ type: "click", ...point, button: "right" }).catch((err) => setStatus(err.message, "err"));
  });
  frame.addEventListener("mousemove", (event) => {
    if (event.buttons === 0) return;
    const point = imagePoint(event);
    if (!point) return;
    void sendInput({ type: "move", ...point }).catch(() => {});
  });
  frame.addEventListener("wheel", (event) => {
    event.preventDefault();
    void sendInput({
      type: "scroll",
      deltaX: Math.max(-10, Math.min(10, Math.round(event.deltaX / 80))),
      deltaY: Math.max(-10, Math.min(10, Math.round(event.deltaY / 80)))
    }).catch((err) => setStatus(err.message, "err"));
  }, { passive: false });

  document.getElementById("connect").addEventListener("click", applyConnection);
  document.getElementById("type").addEventListener("click", () => {
    const value = text.value;
    if (!value) return;
    void sendInput({ type: "type", text: value }).then(() => { text.value = ""; }).catch((err) => setStatus(err.message, "err"));
  });
  for (const button of document.querySelectorAll("[data-key]")) {
    button.addEventListener("click", () => {
      void sendInput({ type: "keypress", keys: button.getAttribute("data-key") }).catch((err) => setStatus(err.message, "err"));
    });
  }
  stage.addEventListener("keydown", (event) => {
    const keyMap = { Enter: "Enter", Escape: "Escape", Tab: "Tab", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Backspace: "Backspace" };
    const mapped = keyMap[event.key];
    if (!mapped) return;
    event.preventDefault();
    void sendInput({ type: "keypress", keys: mapped }).catch((err) => setStatus(err.message, "err"));
  });
  document.getElementById("stop").addEventListener("click", async () => {
    if (!state.sessionId || !state.token) return;
    const response = await fetch(endpoint("/api/apps/screenshare/session/" + encodeURIComponent(state.sessionId) + "/stop"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Screenshare-Token": state.token },
      body: JSON.stringify({ token: state.token })
    });
    if (response.ok) {
      disconnect("Stopped");
    }
  });
  applyConnection();
})();
</script>
</body>
</html>`;
}
