type HyperscapeRouteHandler = (context: {
  req: unknown;
  res: unknown;
  method: string;
  pathname: string;
  relayHyperscapeApi: unknown;
  readJsonBody: unknown;
  error: unknown;
}) => boolean | Promise<boolean>;

let cachedHyperscapeRouteHandler: HyperscapeRouteHandler | null | undefined;

async function loadHyperscapeRouteHandler(): Promise<HyperscapeRouteHandler | null> {
  if (cachedHyperscapeRouteHandler !== undefined) {
    return cachedHyperscapeRouteHandler;
  }

  try {
    const module = (await import("@elizaos/app-hyperscape/routes")) as {
      handleAppsHyperscapeRoutes?: HyperscapeRouteHandler;
    };
    cachedHyperscapeRouteHandler = module.handleAppsHyperscapeRoutes ?? null;
  } catch {
    cachedHyperscapeRouteHandler = null;
  }

  return cachedHyperscapeRouteHandler;
}

export async function maybeHandleAppsHyperscapeRoutes(
  context: Parameters<NonNullable<HyperscapeRouteHandler>>[0],
): Promise<boolean> {
  const routeHandler = await loadHyperscapeRouteHandler();
  if (!routeHandler) {
    return false;
  }
  return Boolean(await routeHandler(context));
}
