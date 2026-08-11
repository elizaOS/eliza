/**
 * Detect whether an Ollama-compatible host is zerollama (strict `/api/chat` schema).
 *
 * Stock Ollama tolerates AI SDK aliases (`temperature`, `max_output_tokens` at the
 * top level of `/api/chat`). Zerollama rejects those with HTTP 400 `unknown field`.
 * Probe `GET /api/version` once per API base and cache the flavor for the process.
 *
 * Override with `OLLAMA_HOST_FLAVOR=zerollama|ollama` when the probe is blocked.
 */

import { logger } from "@elizaos/core";

export type OllamaHostFlavor = "zerollama" | "ollama" | "unknown";

type FlavorCacheEntry = {
  flavor: OllamaHostFlavor;
  probedAtMs: number;
};

const FLAVOR_TTL_MS = 5 * 60_000;
const flavorByApiBase = new Map<string, FlavorCacheEntry>();

function normalizeApiBase(baseURL: string): string {
  const trimmed = baseURL.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed.slice(0, -4) : trimmed;
}

function readFlavorOverride(): OllamaHostFlavor | null {
  const raw = process.env.OLLAMA_HOST_FLAVOR?.trim().toLowerCase();
  if (raw === "zerollama" || raw === "zero") return "zerollama";
  if (raw === "ollama" || raw === "stock") return "ollama";
  return null;
}

function classifyVersionPayload(payload: unknown): OllamaHostFlavor {
  if (!payload || typeof payload !== "object") return "unknown";
  const body = payload as Record<string, unknown>;
  if (typeof body.distribution === "string") {
    const dist = body.distribution.trim().toLowerCase();
    if (dist === "zerollama" || dist.includes("zerollama")) return "zerollama";
    if (dist === "ollama") return "ollama";
  }
  if (body.zerollama != null && typeof body.zerollama === "object") {
    return "zerollama";
  }
  if (typeof body.version === "string" && body.version.length > 0) {
    return "ollama";
  }
  return "unknown";
}

/** Test seam — clear the process-wide flavor cache. */
export function clearOllamaHostFlavorCache(): void {
  flavorByApiBase.clear();
}

/** Test seam — pin a flavor for an API base without probing. */
export function setOllamaHostFlavorForTest(baseURL: string, flavor: OllamaHostFlavor): void {
  flavorByApiBase.set(normalizeApiBase(baseURL), {
    flavor,
    probedAtMs: Date.now(),
  });
}

/**
 * Resolve the host flavor for `baseURL` (`…/api` or origin). Cached; override via
 * `OLLAMA_HOST_FLAVOR`. Probe failures degrade to `"unknown"` (AI SDK path).
 */
export async function resolveOllamaHostFlavor(
  baseURL: string,
  fetchImpl: typeof fetch = fetch
): Promise<OllamaHostFlavor> {
  const override = readFlavorOverride();
  if (override) return override;

  const apiBase = normalizeApiBase(baseURL);
  const cached = flavorByApiBase.get(apiBase);
  if (cached && Date.now() - cached.probedAtMs < FLAVOR_TTL_MS) {
    return cached.flavor;
  }

  let flavor: OllamaHostFlavor = "unknown";
  try {
    const response = await fetchImpl(`${apiBase}/api/version`, {
      method: "GET",
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) {
      flavor = classifyVersionPayload(await response.json());
    } else {
      logger.debug(`[ollama] /api/version returned ${response.status}; host flavor unknown`);
    }
  } catch (err) {
    // error-policy:J4 host detection is an optional optimization; the explicit
    // unknown flavor selects the stock-compatible path and remains visible.
    logger.debug(
      `[ollama] /api/version probe failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  flavorByApiBase.set(apiBase, { flavor, probedAtMs: Date.now() });
  if (flavor === "zerollama") {
    logger.info(
      `[ollama] Detected zerollama at ${apiBase} — using native /api/chat + /api/embed (no AI SDK wire aliases)`
    );
  }
  return flavor;
}

export function isZerollamaFlavor(flavor: OllamaHostFlavor): boolean {
  return flavor === "zerollama";
}
