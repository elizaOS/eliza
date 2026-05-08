/**
 * Browser workspace HTTP routes.
 *
 * The runtime mounts these via `Plugin.routes` with `rawPath: true` so the
 * legacy `/api/browser-workspace/*` paths are preserved. Implementation
 * lives in `@elizaos/plugin-browser/workspace`; this is the HTTP edge.
 */

import type { RouteRequestContext } from "@elizaos/agent/api/route-helpers";
import {
  type BrowserWorkspaceCommand,
  closeBrowserWorkspaceTab,
  evaluateBrowserWorkspaceTab,
  executeBrowserWorkspaceCommand,
  getBrowserWorkspaceSnapshot,
  getBrowserWorkspaceUnavailableMessage,
  hideBrowserWorkspaceTab,
  listBrowserWorkspaceTabs,
  navigateBrowserWorkspaceTab,
  openBrowserWorkspaceTab,
  showBrowserWorkspaceTab,
  snapshotBrowserWorkspaceTab,
} from "@elizaos/plugin-browser/workspace";

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
};

type EvaluateBrowserWorkspaceBody = {
  script?: string;
};

type BrowserWorkspaceCommandBody = BrowserWorkspaceCommand;

export interface BrowserWorkspaceRouteContext extends RouteRequestContext {}

export async function handleBrowserWorkspaceRoutes(
  ctx: BrowserWorkspaceRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, readJsonBody, json } = ctx;

  if (
    pathname !== "/api/browser-workspace" &&
    pathname !== "/api/browser-workspace/command" &&
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

    if (pathname === "/api/browser-workspace/command" && method === "POST") {
      const body =
        (await readJsonBody<BrowserWorkspaceCommandBody>(req, res)) ?? null;
      if (!body?.subaction) {
        json(res, { error: "subaction is required" }, 400);
        return true;
      }
      json(res, await executeBrowserWorkspaceCommand(body));
      return true;
    }

    if (pathname === "/api/browser-workspace/tabs" && method === "GET") {
      json(res, { tabs: await listBrowserWorkspaceTabs() });
      return true;
    }

    if (pathname === "/api/browser-workspace/tabs" && method === "POST") {
      const body =
        (await readJsonBody<OpenBrowserWorkspaceBody>(req, res)) ?? {};
      json(res, { tab: await openBrowserWorkspaceTab(body) });
      return true;
    }

    const match = pathname.match(
      /^\/api\/browser-workspace\/tabs\/([^/]+)(?:\/(navigate|eval|show|hide|snapshot))?$/,
    );
    if (!match) {
      return false;
    }

    const tabId = decodeURIComponent(match[1]).trim();
    const action = match[2] ?? null;

    if (!action && method === "DELETE") {
      const closed = await closeBrowserWorkspaceTab(tabId);
      json(
        res,
        closed ? { closed: true } : { closed: false },
        closed ? 200 : 404,
      );
      return true;
    }

    if (action === "show" && method === "POST") {
      json(res, { tab: await showBrowserWorkspaceTab(tabId) });
      return true;
    }

    if (action === "hide" && method === "POST") {
      json(res, { tab: await hideBrowserWorkspaceTab(tabId) });
      return true;
    }

    if (action === "snapshot" && method === "GET") {
      json(res, await snapshotBrowserWorkspaceTab(tabId));
      return true;
    }

    if (action === "navigate" && method === "POST") {
      const body = await readJsonBody<NavigateBrowserWorkspaceBody>(req, res);
      if (!body?.url?.trim()) {
        json(res, { error: "url is required" }, 400);
        return true;
      }
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
      if (!body?.script?.trim()) {
        json(res, { error: "script is required" }, 400);
        return true;
      }
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
    const status = message.includes(getBrowserWorkspaceUnavailableMessage())
      ? 503
      : message.includes("only available in the desktop app")
        ? 409
        : message.includes("failed (404)")
          ? 404
          : message.includes("failed (409)")
            ? 409
            : 500;
    json(res, { error: message }, status);
    return true;
  }
}

export const BROWSER_WORKSPACE_ROUTE_PATHS: Array<{
  type: string;
  path: string;
}> = [
  { type: "GET", path: "/api/browser-workspace" },
  { type: "POST", path: "/api/browser-workspace/command" },
  { type: "GET", path: "/api/browser-workspace/tabs" },
  { type: "POST", path: "/api/browser-workspace/tabs" },
  { type: "DELETE", path: "/api/browser-workspace/tabs/:tabId" },
  { type: "POST", path: "/api/browser-workspace/tabs/:tabId/show" },
  { type: "POST", path: "/api/browser-workspace/tabs/:tabId/hide" },
  { type: "GET", path: "/api/browser-workspace/tabs/:tabId/snapshot" },
  { type: "POST", path: "/api/browser-workspace/tabs/:tabId/navigate" },
  { type: "POST", path: "/api/browser-workspace/tabs/:tabId/eval" },
];
