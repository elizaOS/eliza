/** Forward only the API path and query to the local backend. */
export function createBackendRequest(
  request: Request,
  backendUrl: string,
): Request {
  const source = new URL(request.url);
  if (source.pathname !== "/api" && !source.pathname.startsWith("/api/")) {
    throw new TypeError("Only /api requests can be forwarded to the backend.");
  }
  const target = new URL(backendUrl);
  target.pathname = source.pathname.slice("/api".length) || "/";
  target.search = source.search;
  return new Request(new Request(target, request), { redirect: "error" });
}
