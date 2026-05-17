export function isConnectorOAuthCallbackEndpoint(
  method: string,
  pathname: string,
): boolean {
  return (
    (method === "GET" || method === "POST") &&
    /^\/api\/connectors\/[^/]+\/oauth\/callback(?:\/[^/]+)?$/.test(pathname)
  );
}
