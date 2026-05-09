/**
 * Browser workspace HTTP routes.
 *
 * The runtime mounts these via `Plugin.routes` with `rawPath: true` so the
 * legacy `/api/browser-workspace/*` paths are preserved. Implementation
 * lives in `@elizaos/plugin-browser/workspace`; this is the HTTP edge.
 */

import type { RouteRequestContext } from "@elizaos/core";
import type { IAgentRuntime } from "@elizaos/core";
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
        (await readJsonBody<OpenBrowserWorkspaceBody>(req, res)) ?? {};
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
      /^\/api\/browser-workspace\/tabs\/([^/]+)(?:\/(navigate|eval|show|hide|snapshot))?$/,
    );
    if (!match) {
      return false;
    }

    const tabId = decodeURIComponent(match[1]).trim();
    const action = match[2] ?? null;

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
