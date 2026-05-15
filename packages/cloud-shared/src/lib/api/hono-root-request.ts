type HonoFetchable = {
  fetch(
    request: Request,
    env?: Record<string, unknown>,
    executionCtx?: unknown,
  ): Response | Promise<Response>;
};

export function toHonoRootRequest(request: Request): Request {
  const url = new URL(request.url);
  url.pathname = "/";
  return new Request(url, request);
}

export function fetchHonoRoot(
  app: HonoFetchable,
  request: Request,
  env: Record<string, unknown> = {},
): Response | Promise<Response> {
  return app.fetch(toHonoRootRequest(request), env);
}
