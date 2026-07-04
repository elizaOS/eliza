/**
 * Permanent redirect Worker from the legacy Eliza Cloud docs hostname to the
 * unified docs site at docs.elizaos.ai/cloud.
 *
 * Path and query are preserved. A legacy `/docs` prefix is stripped because the
 * canonical cloud docs hostname does not use that path segment.
 */

const TARGET_ORIGIN = "https://docs.elizaos.ai";
const TARGET_PREFIX = "/cloud";

export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    let path = url.pathname.replace(/\/{2,}/g, "/");
    if (path.startsWith("/docs/")) path = path.slice("/docs".length);
    else if (path === "/docs") path = "";
    if (path === "/") path = "";
    const location = `${TARGET_ORIGIN}${TARGET_PREFIX}${path}${url.search}`;
    return Response.redirect(location, 301);
  },
};
