/** HTML injection — inject API base URL into served HTML pages. */
import { injectApiBaseIntoHtml as upstreamInjectApiBaseIntoHtml } from "@elizaos/agent";

export function injectApiBaseIntoHtml(
  ...args: Parameters<typeof upstreamInjectApiBaseIntoHtml>
): ReturnType<typeof upstreamInjectApiBaseIntoHtml> {
  return upstreamInjectApiBaseIntoHtml(...args);
}
