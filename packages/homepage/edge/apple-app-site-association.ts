/**
 * Serves the canonical iOS association document at the eliza.app edge.
 *
 * GitHub Pages does not honor `_headers`, so the production Cloudflare route
 * owns only the exact AASA URL and forwards every other request unchanged to
 * the existing Pages origin. The release identity remains edge-only so the
 * develop-published Pages tree continues serving its deliberately inert file.
 */

import associationBody from "./apple-app-site-association.json" with {
  type: "text",
};

export const APPLE_APP_SITE_ASSOCIATION_URL =
  "https://eliza.app/.well-known/apple-app-site-association";

type OriginFetch = (request: Request) => Promise<Response>;

export async function handleAppleAppSiteAssociationRequest(
  request: Request,
  originFetch: OriginFetch = fetch,
): Promise<Response> {
  const isAssociationRequest =
    request.url === APPLE_APP_SITE_ASSOCIATION_URL &&
    (request.method === "GET" || request.method === "HEAD");

  if (!isAssociationRequest) {
    return originFetch(request);
  }

  return new Response(request.method === "HEAD" ? null : associationBody, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export default {
  fetch(request: Request): Promise<Response> {
    return handleAppleAppSiteAssociationRequest(request);
  },
};
