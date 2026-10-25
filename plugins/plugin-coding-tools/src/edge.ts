/** Public WEB_FETCH only; never loads the Node coding plugin or grants its role. */

import {
  isBlockedHostname,
  isPrivateIpAddress,
  isSensitiveKeyName,
  redactSensitiveText,
} from "@elizaos/core";
import { fetchKeylessWeb } from "@elizaos/plugin-web-search/edge";
import {
  createWebFetchAction,
  type WebFetchReader,
} from "./actions/web-fetch-core.js";
import { readTextWithinLimit } from "./lib/web-response.js";

function isFreshPublicWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (
      url.href !== value ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      (url.port && url.port !== "443") ||
      isBlockedHostname(url.hostname) ||
      isPrivateIpAddress(url.hostname)
    )
      return false;
    for (const [key, value] of url.searchParams)
      if (
        isSensitiveKeyName(key) ||
        redactSensitiveText(value) !== value ||
        /^(?:token|key|auth|sig|signature|session|session[_-]?id|code)$/iu.test(
          key,
        )
      )
        return false;
    return true;
  } catch {
    return false;
  }
}
/** Fixed operator-reviewed public API origins, not generic DNS-pinned SSRF protection. */
const DIRECT_PUBLIC_ORIGINS = new Set([
  "https://api.coingecko.com",
  "https://wttr.in",
]);

async function readTrustedPublicOrigin(url: string, caller?: AbortSignal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(caller?.reason);
  if (caller?.aborted) onAbort();
  else caller?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException("Public API read timed out", "TimeoutError"),
      ),
    15000,
  );
  let response: Response | undefined;
  try {
    controller.signal.throwIfAborted();
    response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/json,text/plain;q=0.9",
        "User-Agent": "ElizaCodingTools/1.0 (+https://elizaos.ai)",
      },
    });
    if (response.status >= 300 && response.status < 400)
      throw new Error("Public API redirect refused");
    const contentType = response.headers.get("content-type") ?? "";
    const type = contentType.split(";")[0].trim().toLowerCase();
    if (
      !(
        type.startsWith("text/") ||
        type === "application/json" ||
        type.endsWith("+json")
      )
    )
      throw new Error("Public API content type refused");
    if (response.url && response.url !== url)
      throw new Error("Public API response URL changed");
    const text = await readTextWithinLimit(
      response,
      262144,
      controller.signal,
      true,
    );
    return {
      kind: "origin-http" as const,
      ok: response.ok,
      status: response.status,
      url,
      contentType,
      text,
      truncated: false as const,
    };
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", onAbort);
    if (response && !response.bodyUsed)
      void response.body?.cancel().catch(() => {});
  }
}

export function createWebFetchEdgeAction() {
  const reader: WebFetchReader = async (url, signal) => {
    signal?.throwIfAborted();
    if (!isFreshPublicWebUrl(url))
      throw new Error("A safe canonical public HTTPS URL is required");
    if (DIRECT_PUBLIC_ORIGINS.has(new URL(url).origin))
      return readTrustedPublicOrigin(url, signal);
    const result = await fetchKeylessWeb([url], {
      signal,
      timeoutMs: 5000,
      maxResponseBytes: 262144,
      objective:
        "Read this URL and return its source content, including exact numeric values and units. If it is a JSON API, preserve the JSON. Report inability to read it; do not invent data.",
      fullContent: true,
    });
    if (!result) throw new Error("Public URL reader returned no content");
    const body = JSON.parse(result.text) as {
      results?: Array<{
        url?: unknown;
        title?: unknown;
        excerpts?: unknown;
        full_content?: unknown;
      }>;
      errors?: unknown[];
    };
    if (
      !Array.isArray(body.results) ||
      body.results.length !== 1 ||
      !Array.isArray(body.errors) ||
      body.errors.length !== 0
    )
      throw new Error("Public URL reader returned incomplete evidence");
    const record = body.results[0];
    if (
      record.url !== url ||
      typeof record.title !== "string" ||
      !Array.isArray(record.excerpts) ||
      !record.excerpts.every((value) => typeof value === "string") ||
      (!record.excerpts.some(
        (value) => typeof value === "string" && value.trim(),
      ) &&
        !(
          typeof record.full_content === "string" && record.full_content.trim()
        ))
    )
      throw new Error("Public URL reader returned mismatched evidence");
    signal?.throwIfAborted();
    return {
      kind: "provider-extract",
      provider: "parallel",
      url,
      text: JSON.stringify(record),
      observedAt: Date.now(),
      truncated: false,
    };
  };
  return createWebFetchAction(reader, {
    roleGate: { minRole: "GUEST" },
    contexts: ["web", "general"],
    contextGate: { anyOf: ["web", "general"] },
    routingHint:
      "Read ONE known or constructable public HTTPS URL or JSON API -> WEB_FETCH; spot crypto price -> https://api.coingecko.com/api/v3/simple/price?ids=<coin>&vs_currencies=usd; current weather -> https://wttr.in/<latitude>,<longitude>?format=j1 ; disambiguate coordinates/country and read nearest_area plus observation/date fields before narrowing with extract=current_condition; discover unknown URLs -> WEB_SEARCH.",
    description:
      "Read one public HTTPS URL. Exact api.coingecko.com and wttr.in origins use bounded direct HTTPS GET with no-store and no redirects; JSON extract paths work for these origin responses. Check weather coordinates, nearest_area and observation date before calling it current for a city. Other public URLs use anonymous provider extracts with no origin-freshness guarantee or JSON extraction. Private addresses, credentials, custom ports and sensitive query parameters are rejected.",
  });
}
