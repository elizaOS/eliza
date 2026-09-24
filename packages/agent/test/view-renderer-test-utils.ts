/** Claims a real pending host request; only renderer transport is simulated. */
import type { IAgentRuntime, ViewType } from "@elizaos/core";
import { viewInteractionHost } from "../src/api/view-interaction-host.ts";
import { getView } from "../src/api/views-registry.ts";
import type { ViewsRouteContext } from "../src/api/views-routes.ts";

export function claimRendererReply(
  runtime: IAgentRuntime,
  hostKey: object,
  clientId: string,
  frame: Record<string, unknown>,
) {
  const { requestId, viewId, viewType, installationId } = frame;
  if (
    [requestId, viewId, viewType, installationId].some(
      (part) => typeof part !== "string",
    )
  )
    throw new Error(
      "Renderer fixture received an incomplete installation binding",
    );
  const binding = {
    requestId: requestId as string,
    viewId: viewId as string,
    viewType: viewType as string,
    installationId: installationId as string,
  };
  const claimId = viewInteractionHost(runtime, hostKey).claim(
    clientId,
    binding,
    [],
  );
  if (!claimId)
    throw new Error("Renderer fixture could not claim this request");
  return { ...binding, claimId };
}

/** Resolve fixture resource requests from the active catalog, like a client. */
export function bindCatalogAssetRequest(
  runtime: IAgentRuntime,
  ctx: Pick<ViewsRouteContext, "pathname" | "url">,
): void {
  const asset = ctx.pathname.match(/^\/api\/views\/([^/]+)\/(.+)$/);
  if (!asset || !/\.[^/]+$/.test(asset[2])) return;
  const entry = getView(runtime, decodeURIComponent(asset[1]), {
    viewType: (ctx.url.searchParams.get("viewType") ?? "gui") as ViewType,
  });
  if (!entry) return;
  const root = asset[2] === "frame.html" ? entry.frameUrl : entry.bundleUrl;
  if (!root?.startsWith("/api/views/")) {
    if (entry.installationId)
      ctx.url.searchParams.set("installation", entry.installationId);
    return;
  }
  const target = new URL(root, ctx.url);
  // Keep malformed path bytes intact for route-validation tests.
  ctx.pathname =
    target.pathname.slice(0, target.pathname.lastIndexOf("/") + 1) + asset[2];
  if (asset[2] !== "bundle.js" && asset[2] !== "frame.html")
    target.searchParams.delete("v");
  for (const [key, value] of ctx.url.searchParams)
    target.searchParams.set(key, value);
  target.pathname = ctx.pathname;
  ctx.url = target;
}
