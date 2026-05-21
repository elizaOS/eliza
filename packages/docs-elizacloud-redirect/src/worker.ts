// Permanent redirect from the legacy Eliza Cloud docs hostname
// (docs.elizacloud.ai) to the unified docs site at docs.elizaos.ai/cloud.
//
// Path and query are preserved:
//   docs.elizacloud.ai/quickstart        -> docs.elizaos.ai/cloud/quickstart
//   docs.elizacloud.ai/api/agents?x=1    -> docs.elizaos.ai/cloud/api/agents?x=1
//   docs.elizacloud.ai/                  -> docs.elizaos.ai/cloud
//
// The /docs prefix that old elizacloud.ai/docs/* URLs carried is stripped if
// present, since the new hostname does not use that prefix.

const TARGET_ORIGIN = "https://docs.elizaos.ai";
const TARGET_PREFIX = "/cloud";

export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    let path = url.pathname;
    if (path.startsWith("/docs/")) path = path.slice("/docs".length);
    else if (path === "/docs") path = "";
    if (path === "/") path = "";
    const location = `${TARGET_ORIGIN}${TARGET_PREFIX}${path}${url.search}`;
    return Response.redirect(location, 301);
  },
};
