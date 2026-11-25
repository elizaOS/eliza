import type http from "node:http";
import { fetchWithSsrfGuard, nodeLookupFn, nodePinnedFetch } from "@elizaos/core";
import { readJsonBody, sendJson } from "../lib/http";

const MAX_PAGE_BYTES = 256 * 1024;
const READ_TIMEOUT_MS = 3_000;

/** An anonymous public copy for a resident Browser whose isolated reader is unavailable. */
export async function handleBrowserSourceRoute(req: unknown, res: unknown) {
  const request = req as http.IncomingMessage;
  const response = res as http.ServerResponse;
  const body = await readJsonBody<{ url?: unknown }>(request, response, { maxBytes: 4096 });
  if (!body) return;
  let url: URL;
  try {
    if (typeof body.url !== "string" || body.url.length > 2048) throw new Error();
    url = new URL(body.url);
    // A public copy must not forward page credentials or query/fragment values.
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port)
      throw new Error();
  } catch {
    sendJson(response, { source: null });
    return;
  }
  try {
    const page = await fetchWithSsrfGuard({
      url: url.href,
      lookupFn: nodeLookupFn,
      pinnedFetchImpl: nodePinnedFetch,
      maxRedirects: 0,
      timeoutMs: READ_TIMEOUT_MS,
      init: {
        method: "GET",
        headers: { Accept: "text/html,text/plain" },
        credentials: "omit",
        referrerPolicy: "no-referrer",
      },
    });
    try {
      const contentType = page.response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
      const reader = page.response.body?.getReader();
      if (!reader) {
        sendJson(response, { source: null });
        return;
      }
      try {
        if (!page.response.ok || page.finalUrl !== url.href ||
            (contentType !== "text/html" && contentType !== "text/plain") ||
            Number(page.response.headers.get("content-length")) > MAX_PAGE_BYTES) {
          sendJson(response, { source: null });
          return;
        }
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let bytes = 0;
        let source = "";
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > MAX_PAGE_BYTES) {
            sendJson(response, { source: null });
            return;
          }
          source += decoder.decode(part.value, { stream: true });
        }
        sendJson(response, { source: source + decoder.decode(), contentType });
      } finally {
        await reader.cancel().catch(() => {});
      }
    } finally {
      await page.release();
    }
  } catch {
    sendJson(response, { source: null });
  }
}
