/**
 * Browser workspace HTTP routes.
 *
 * The runtime mounts these via `Plugin.routes` with `rawPath: true` so the
 * legacy `/api/browser-workspace/*` paths are preserved. Implementation
 * lives in `@elizaos/plugin-browser/workspace`; this is the HTTP edge.
 */

import {
  type IAgentRuntime,
  logger,
  type RouteRequestContext,
} from "@elizaos/core";
import { requestBrowserWorkspace } from "../workspace/browser-workspace-desktop.js";
import {
  type BrowserWorkspaceErrorCode,
  createBrowserWorkspaceError,
  isBrowserWorkspaceError,
} from "../workspace/browser-workspace-errors.js";
import { assertBrowserWorkspaceUserScriptAllowed } from "../workspace/browser-workspace-helpers.js";
import type {
  BrowserWorkspaceEventLogSnapshot,
  BrowserWorkspaceInput,
  BrowserWorkspaceViewport,
} from "../workspace/browser-workspace-types.js";
import {
  type BrowserWorkspaceCommand,
  closeBrowserWorkspaceTab,
  dispatchChromiumBrowserWorkspaceInput,
  evaluateBrowserWorkspaceTab,
  executeBrowserWorkspaceCommand,
  getBrowserWorkspaceSnapshot,
  getBrowserWorkspaceUnavailableMessage,
  hideBrowserWorkspaceTab,
  isBrowserWorkspaceBridgeConfigured,
  listBrowserWorkspaceTabs,
  navigateBrowserWorkspaceTab,
  openBrowserWorkspaceTab,
  resizeChromiumBrowserWorkspaceTab,
  showBrowserWorkspaceTab,
  snapshotBrowserWorkspaceTab,
  subscribeChromiumBrowserWorkspaceFrames,
} from "../workspace/index.js";
import {
  assertBrowserWorkspaceCommandConnectorAccountGate,
  assertBrowserWorkspaceConnectorAccountGate,
} from "./workspace-account-gate.js";

type OpenBrowserWorkspaceBody = {
  url?: string;
  title?: string;
  show?: boolean;
  partition?: string;
  connectorProvider?: string;
  connectorAccountId?: string;
  kind?: "internal" | "standard";
  width?: number;
  height?: number;
};

type NavigateBrowserWorkspaceBody = {
  url?: string;
  partition?: string;
  connectorProvider?: string;
  connectorAccountId?: string;
};

type EvaluateBrowserWorkspaceBody = {
  script?: string;
  partition?: string;
  connectorProvider?: string;
  connectorAccountId?: string;
};

type BrowserWorkspaceInputBody = {
  input?: BrowserWorkspaceInput;
};

type BrowserWorkspaceViewportBody = {
  viewport?: BrowserWorkspaceViewport;
};

type BrowserWorkspaceCommandBody = BrowserWorkspaceCommand;
type BrowserWorkspaceConnectorReference = {
  partition?: string | null;
  connectorProvider?: string | null;
  connectorAccountId?: string | null;
};

export interface BrowserWorkspaceRouteContext extends RouteRequestContext {
  url?: URL;
  state?: {
    runtime?: IAgentRuntime | null;
  };
}

function statusFromBrowserWorkspaceErrorCode(
  code: BrowserWorkspaceErrorCode,
  message: string,
): number {
  switch (code) {
    case "invalid_url":
    case "unknown_element_ref":
      return 400;
    case "tab_not_found":
      return 404;
    case "target_missing":
      return 409;
    case "desktop_only":
      return message.includes(getBrowserWorkspaceUnavailableMessage())
        ? 503
        : 409;
    case "script_forbidden":
    case "connector_secret_export_forbidden":
      return 403;
    case "timeout":
      return 504;
    case "command_failed":
      return 500;
  }
}

function statusFromBrowserWorkspaceError(
  error: unknown,
  message: string,
): number {
  if (
    error instanceof Error &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error.status;
  }
  if (isBrowserWorkspaceError(error)) {
    return statusFromBrowserWorkspaceErrorCode(
      error.browserWorkspaceErrorCode,
      message,
    );
  }
  if (message.includes(getBrowserWorkspaceUnavailableMessage())) {
    return 503;
  }
  if (message.includes("only available in the desktop app")) {
    return 409;
  }
  if (message.includes("failed (404)")) {
    return 404;
  }
  if (message.includes("failed (409)")) {
    return 409;
  }
  return 500;
}

function connectorReferenceFromSearchParams(
  url: URL | undefined,
): BrowserWorkspaceConnectorReference {
  return {
    connectorProvider: url?.searchParams.get("connectorProvider"),
    connectorAccountId: url?.searchParams.get("connectorAccountId"),
    partition: url?.searchParams.get("partition"),
  };
}

function buildBrowserWorkspaceEventsBridgePath(url: URL | undefined): string {
  const params = new URLSearchParams();
  for (const key of ["after", "limit", "tabId", "type"]) {
    const value = url?.searchParams.get(key)?.trim();
    if (value) {
      params.set(key, value);
    }
  }
  const query = params.toString();
  return query ? `/events?${query}` : "/events";
}

function isBrowserWorkspaceRouteBodyObject(
  value: unknown,
): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function rejectMalformedBrowserWorkspacePayload(
  ctx: BrowserWorkspaceRouteContext,
): true {
  ctx.json(ctx.res, { error: "request body must be a JSON object" }, 400);
  return true;
}

function decodeBrowserWorkspaceTabId(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  try {
    const decoded = decodeURIComponent(raw).trim();
    return decoded ? decoded : null;
  } catch {
    // error-policy:J3 untrusted-input sanitizing — decodeURIComponent throws on
    // a malformed percent-encoding in a path param; null is the explicit
    // "invalid tab id" signal (the route then 404s), never a fabricated id.
    return null;
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseBrowserWorkspaceInput(
  value: unknown,
): BrowserWorkspaceInput | null {
  if (!isBrowserWorkspaceRouteBodyObject(value)) return null;
  if (value.type === "pointer") {
    if (
      !["down", "move", "up"].includes(String(value.phase)) ||
      !isFiniteNumber(value.x) ||
      !isFiniteNumber(value.y) ||
      (value.button !== undefined &&
        !["left", "middle", "right"].includes(String(value.button)))
    ) {
      return null;
    }
    return {
      type: "pointer",
      phase: value.phase as "down" | "move" | "up",
      x: value.x,
      y: value.y,
      ...(value.button
        ? { button: value.button as "left" | "middle" | "right" }
        : {}),
    };
  }
  if (value.type === "wheel") {
    if (
      !isFiniteNumber(value.x) ||
      !isFiniteNumber(value.y) ||
      !isFiniteNumber(value.deltaX) ||
      !isFiniteNumber(value.deltaY)
    ) {
      return null;
    }
    return {
      type: "wheel",
      x: value.x,
      y: value.y,
      deltaX: value.deltaX,
      deltaY: value.deltaY,
    };
  }
  if (value.type === "key") {
    if (
      !["down", "up"].includes(String(value.phase)) ||
      typeof value.key !== "string" ||
      value.key.length === 0 ||
      value.key.length > 64 ||
      (value.text !== undefined && typeof value.text !== "string")
    ) {
      return null;
    }
    return {
      type: "key",
      phase: value.phase as "down" | "up",
      key: value.key,
      ...(typeof value.text === "string" ? { text: value.text } : {}),
    };
  }
  if (
    value.type === "text" &&
    typeof value.text === "string" &&
    value.text.length > 0 &&
    value.text.length <= 100_000
  ) {
    return { type: "text", text: value.text };
  }
  return null;
}

function parseBrowserWorkspaceViewport(
  value: unknown,
): BrowserWorkspaceViewport | null {
  if (
    !isBrowserWorkspaceRouteBodyObject(value) ||
    !isFiniteNumber(value.width) ||
    !isFiniteNumber(value.height) ||
    (value.deviceScaleFactor !== undefined &&
      !isFiniteNumber(value.deviceScaleFactor))
  ) {
    return null;
  }
  return {
    width: value.width,
    height: value.height,
    ...(isFiniteNumber(value.deviceScaleFactor)
      ? { deviceScaleFactor: value.deviceScaleFactor }
      : {}),
  };
}

async function streamBrowserWorkspaceFrames(
  ctx: BrowserWorkspaceRouteContext,
  tabId: string,
): Promise<void> {
  const { req, res } = ctx;
  let closed = false;
  let headersWritten = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => Promise<void>) | null = null;
  let pendingFrame:
    | Parameters<
        Parameters<typeof subscribeChromiumBrowserWorkspaceFrames>[1]
      >[0]
    | null = null;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    const release = unsubscribe;
    unsubscribe = null;
    if (release) await release();
  };
  const closeAtBoundary = (): void => {
    void close().catch((error) => {
      // error-policy:J6 the HTTP peer already owns stream termination; report
      // Chromium session cleanup races without turning teardown into a crash.
      logger.debug(
        `[BrowserWorkspace] frame stream cleanup skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };
  const writeFrame = (frame: NonNullable<typeof pendingFrame>): void => {
    if (closed || res.destroyed) return;
    if (!headersWritten) {
      pendingFrame = frame;
      return;
    }
    // A slow client needs the newest rendered state, not an ever-growing
    // backlog of obsolete JPEGs. CDP continues receiving acknowledgements,
    // while the HTTP edge drops frames until the socket drains.
    if (!res.writableNeedDrain) {
      res.write(`${JSON.stringify({ type: "frame", ...frame })}\n`);
    }
  };

  // IncomingMessage "close" also fires after an ordinary completed GET on
  // current Node releases. Only an aborted request or the response socket
  // closing means the long-lived frame subscription has lost its consumer.
  req.once("aborted", closeAtBoundary);
  res.once("close", closeAtBoundary);
  unsubscribe = await subscribeChromiumBrowserWorkspaceFrames(
    tabId,
    writeFrame,
  );
  if (closed || res.destroyed) {
    const release = unsubscribe;
    unsubscribe = null;
    await release();
    return;
  }
  res.writeHead(200, {
    "cache-control": "no-cache, no-store, must-revalidate",
    connection: "keep-alive",
    "content-type": "application/x-ndjson; charset=utf-8",
    "x-accel-buffering": "no",
  });
  headersWritten = true;
  res.write(`${JSON.stringify({ type: "ready" })}\n`);
  if (pendingFrame) {
    const initialFrame = pendingFrame;
    pendingFrame = null;
    writeFrame(initialFrame);
  }
  heartbeat = setInterval(() => {
    if (!closed && !res.destroyed && !res.writableNeedDrain) {
      res.write(`${JSON.stringify({ type: "heartbeat" })}\n`);
    }
  }, 15_000);
}

async function assertBrowserWorkspaceTabConnectorAccountGate(
  ctx: BrowserWorkspaceRouteContext,
  tabId: string,
  reference: BrowserWorkspaceConnectorReference,
  operation: string,
): Promise<void> {
  const tabs = await listBrowserWorkspaceTabs();
  const tab = tabs.find((entry) => entry.id === tabId) ?? null;
  await assertBrowserWorkspaceConnectorAccountGate({
    runtime: ctx.state?.runtime ?? null,
    connectorProvider: reference.connectorProvider,
    connectorAccountId: reference.connectorAccountId,
    partition: tab?.partition ?? reference.partition,
    operation,
  });
}

export async function handleBrowserWorkspaceRoutes(
  ctx: BrowserWorkspaceRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, readJsonBody, json } = ctx;

  if (
    pathname !== "/api/browser-workspace" &&
    pathname !== "/api/browser-workspace/command" &&
    pathname !== "/api/browser-workspace/events" &&
    pathname !== "/api/browser-workspace/tabs" &&
    !pathname.startsWith("/api/browser-workspace/tabs/")
  ) {
    return false;
  }

  try {
    if (pathname === "/api/browser-workspace" && method === "GET") {
      json(res, await getBrowserWorkspaceSnapshot());
      return true;
    }

    if (pathname === "/api/browser-workspace/events" && method === "GET") {
      if (!isBrowserWorkspaceBridgeConfigured()) {
        throw createBrowserWorkspaceError(
          "desktop_only",
          "events",
          getBrowserWorkspaceUnavailableMessage(),
        );
      }
      json(
        res,
        await requestBrowserWorkspace<BrowserWorkspaceEventLogSnapshot>(
          buildBrowserWorkspaceEventsBridgePath(ctx.url),
        ),
      );
      return true;
    }

    if (pathname === "/api/browser-workspace/command" && method === "POST") {
      const body =
        (await readJsonBody<BrowserWorkspaceCommandBody>(req, res)) ?? null;
      if (!isBrowserWorkspaceRouteBodyObject(body)) {
        return rejectMalformedBrowserWorkspacePayload(ctx);
      }
      if (!body?.subaction) {
        json(res, { error: "subaction is required" }, 400);
        return true;
      }
      await assertBrowserWorkspaceCommandConnectorAccountGate({
        runtime: ctx.state?.runtime ?? null,
        command: body,
        operation: "browser workspace command",
      });
      json(res, await executeBrowserWorkspaceCommand(body));
      return true;
    }

    if (pathname === "/api/browser-workspace/tabs" && method === "GET") {
      json(res, { tabs: await listBrowserWorkspaceTabs() });
      return true;
    }

    if (pathname === "/api/browser-workspace/tabs" && method === "POST") {
      const body =
        (await readJsonBody<OpenBrowserWorkspaceBody>(req, res)) ?? null;
      if (!isBrowserWorkspaceRouteBodyObject(body)) {
        return rejectMalformedBrowserWorkspacePayload(ctx);
      }
      const connectorGate = await assertBrowserWorkspaceConnectorAccountGate({
        runtime: ctx.state?.runtime ?? null,
        connectorProvider: body.connectorProvider,
        connectorAccountId: body.connectorAccountId,
        partition: body.partition,
        operation: "open browser workspace tab",
      });
      json(res, {
        tab: await openBrowserWorkspaceTab({
          ...body,
          partition: connectorGate?.expectedPartition ?? body.partition,
        }),
      });
      return true;
    }

    const match = pathname.match(
      /^\/api\/browser-workspace\/tabs\/([^/]+)(?:\/(navigate|eval|show|hide|snapshot|frames|input|viewport))?$/,
    );
    if (!match) {
      return false;
    }

    const tabId = decodeBrowserWorkspaceTabId(match[1]);
    if (!tabId) {
      json(res, { error: "valid tab id is required" }, 400);
      return true;
    }
    const action = match[2] ?? null;

    if (action === "frames" && method === "GET") {
      await assertBrowserWorkspaceTabConnectorAccountGate(
        ctx,
        tabId,
        connectorReferenceFromSearchParams(ctx.url),
        "stream browser workspace tab",
      );
      await streamBrowserWorkspaceFrames(ctx, tabId);
      return true;
    }

    if (action === "input" && method === "POST") {
      const body = await readJsonBody<BrowserWorkspaceInputBody>(req, res);
      if (!isBrowserWorkspaceRouteBodyObject(body)) {
        return rejectMalformedBrowserWorkspacePayload(ctx);
      }
      const input = parseBrowserWorkspaceInput(body.input);
      if (!input) {
        json(res, { error: "valid browser input is required" }, 400);
        return true;
      }
      await assertBrowserWorkspaceTabConnectorAccountGate(
        ctx,
        tabId,
        connectorReferenceFromSearchParams(ctx.url),
        "send browser workspace input",
      );
      await dispatchChromiumBrowserWorkspaceInput(tabId, input);
      json(res, { ok: true });
      return true;
    }

    if (action === "viewport" && method === "POST") {
      const body = await readJsonBody<BrowserWorkspaceViewportBody>(req, res);
      if (!isBrowserWorkspaceRouteBodyObject(body)) {
        return rejectMalformedBrowserWorkspacePayload(ctx);
      }
      const viewport = parseBrowserWorkspaceViewport(body.viewport);
      if (!viewport) {
        json(res, { error: "valid browser viewport is required" }, 400);
        return true;
      }
      await assertBrowserWorkspaceTabConnectorAccountGate(
        ctx,
        tabId,
        connectorReferenceFromSearchParams(ctx.url),
        "resize browser workspace tab",
      );
      await resizeChromiumBrowserWorkspaceTab(tabId, viewport);
      json(res, { ok: true });
      return true;
    }

    if (!action && method === "DELETE") {
      await assertBrowserWorkspaceTabConnectorAccountGate(
        ctx,
        tabId,
        connectorReferenceFromSearchParams(ctx.url),
        "close browser workspace tab",
      );
      const closed = await closeBrowserWorkspaceTab(tabId);
      json(
        res,
        closed ? { closed: true } : { closed: false },
        closed ? 200 : 404,
      );
      return true;
    }

    if (action === "show" && method === "POST") {
      await assertBrowserWorkspaceTabConnectorAccountGate(
        ctx,
        tabId,
        connectorReferenceFromSearchParams(ctx.url),
        "show browser workspace tab",
      );
      json(res, { tab: await showBrowserWorkspaceTab(tabId) });
      return true;
    }

    if (action === "hide" && method === "POST") {
      await assertBrowserWorkspaceTabConnectorAccountGate(
        ctx,
        tabId,
        connectorReferenceFromSearchParams(ctx.url),
        "hide browser workspace tab",
      );
      json(res, { tab: await hideBrowserWorkspaceTab(tabId) });
      return true;
    }

    if (action === "snapshot" && method === "GET") {
      await assertBrowserWorkspaceTabConnectorAccountGate(
        ctx,
        tabId,
        connectorReferenceFromSearchParams(ctx.url),
        "snapshot browser workspace tab",
      );
      json(res, await snapshotBrowserWorkspaceTab(tabId));
      return true;
    }

    if (action === "navigate" && method === "POST") {
      const body = await readJsonBody<NavigateBrowserWorkspaceBody>(req, res);
      if (!isBrowserWorkspaceRouteBodyObject(body)) {
        return rejectMalformedBrowserWorkspacePayload(ctx);
      }
      if (!body?.url?.trim()) {
        json(res, { error: "url is required" }, 400);
        return true;
      }
      await assertBrowserWorkspaceTabConnectorAccountGate(
        ctx,
        tabId,
        body,
        "navigate browser workspace tab",
      );
      json(res, {
        tab: await navigateBrowserWorkspaceTab({
          id: tabId,
          url: body.url,
        }),
      });
      return true;
    }

    if (action === "eval" && method === "POST") {
      const body = await readJsonBody<EvaluateBrowserWorkspaceBody>(req, res);
      if (!isBrowserWorkspaceRouteBodyObject(body)) {
        return rejectMalformedBrowserWorkspacePayload(ctx);
      }
      if (!body?.script?.trim()) {
        json(res, { error: "script is required" }, 400);
        return true;
      }
      await assertBrowserWorkspaceTabConnectorAccountGate(
        ctx,
        tabId,
        body,
        "evaluate browser workspace tab",
      );
      assertBrowserWorkspaceUserScriptAllowed(body.script, "eval", "desktop");
      json(res, {
        result: await evaluateBrowserWorkspaceTab({
          id: tabId,
          script: body.script,
        }),
      });
      return true;
    }

    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = statusFromBrowserWorkspaceError(error, message);
    const body: { code?: BrowserWorkspaceErrorCode; error: string } = {
      error: message,
    };
    if (isBrowserWorkspaceError(error)) {
      body.code = error.browserWorkspaceErrorCode;
    }
    json(res, body, status);
    return true;
  }
}

export const BROWSER_WORKSPACE_ROUTE_PATHS: Array<{
  type: string;
  path: string;
}> = [
  { type: "GET", path: "/api/browser-workspace" },
  { type: "POST", path: "/api/browser-workspace/command" },
  { type: "GET", path: "/api/browser-workspace/events" },
  { type: "GET", path: "/api/browser-workspace/tabs" },
  { type: "POST", path: "/api/browser-workspace/tabs" },
  { type: "DELETE", path: "/api/browser-workspace/tabs/:tabId" },
  { type: "POST", path: "/api/browser-workspace/tabs/:tabId/show" },
  { type: "POST", path: "/api/browser-workspace/tabs/:tabId/hide" },
  { type: "GET", path: "/api/browser-workspace/tabs/:tabId/snapshot" },
  { type: "POST", path: "/api/browser-workspace/tabs/:tabId/navigate" },
  { type: "POST", path: "/api/browser-workspace/tabs/:tabId/eval" },
  { type: "GET", path: "/api/browser-workspace/tabs/:tabId/frames" },
  { type: "POST", path: "/api/browser-workspace/tabs/:tabId/input" },
  { type: "POST", path: "/api/browser-workspace/tabs/:tabId/viewport" },
];
