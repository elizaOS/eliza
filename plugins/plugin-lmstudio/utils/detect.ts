/**
 * LM Studio detection — probes `GET <baseURL>/models` and parses the OpenAI-shaped
 * `{ object: "list", data: [...] }` response. The plugin uses this for two things:
 *
 * 1. Init-time logging: warn the operator if LM Studio is configured but unreachable.
 * 2. The auto-enable predicate: turn the plugin on when the local server responds.
 *
 * Detection is kept side-effect free and accepts an injected `fetch` so unit tests
 * can stub it without touching network state.
 */

import type { LMStudioModelInfo, LMStudioModelsResponse } from "../types";
import { DEFAULT_LMSTUDIO_URL } from "./config";

export interface DetectionOptions {
  baseURL?: string;
  /** Override `fetch` (used by tests and the browser/sandbox build). */
  fetcher?: typeof fetch;
  /** Per-request timeout — LM Studio should answer instantly; bail fast otherwise. */
  timeoutMs?: number;
  /** Optional Bearer token (LM Studio behind an auth proxy). */
  apiKey?: string;
}

export interface DetectionResult {
  available: boolean;
  baseURL: string;
  /** Parsed model list when `available` is true. */
  models?: LMStudioModelInfo[];
  /** Last error encountered when `available` is false. */
  error?: string;
}

function normalizeBaseURL(input: string | undefined): string {
  const raw = (input ?? DEFAULT_LMSTUDIO_URL).replace(/\/+$/, "");
  if (/\/v\d+$/.test(raw)) {
    return raw;
  }
  return `${raw}/v1`;
}

/**
 * Parses a `GET /v1/models` response body, defensively against
 * implementations that return a bare array. Returns null when the body
 * is not a recognizable shape.
 */
export function parseModelsResponse(body: unknown): LMStudioModelInfo[] | null {
  if (Array.isArray(body)) {
    return body.filter((entry): entry is LMStudioModelInfo => {
      return Boolean(entry) && typeof (entry as LMStudioModelInfo).id === "string";
    });
  }

  if (body && typeof body === "object") {
    const shaped = body as Partial<LMStudioModelsResponse>;
    if (Array.isArray(shaped.data)) {
      return shaped.data.filter((entry): entry is LMStudioModelInfo => {
        return Boolean(entry) && typeof entry.id === "string";
      });
    }
  }

  return null;
}

/**
 * Probes the configured LM Studio endpoint. Always returns a result — never throws.
 *
 * Why catch all errors: this helper is called from auto-enable and the plugin `init`
 * hook. A network error during init must not crash the runtime; we surface it via the
 * returned `error` field and let the caller decide what to do.
 */
export async function detectLMStudio(options: DetectionOptions = {}): Promise<DetectionResult> {
  const baseURL = normalizeBaseURL(options.baseURL);
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1500;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.apiKey) {
      headers.Authorization = `Bearer ${options.apiKey}`;
    }

    const response = await fetcher(`${baseURL}/models`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        available: false,
        baseURL,
        error: `HTTP ${response.status} ${response.statusText}`,
      };
    }

    const body = (await response.json()) as unknown;
    const models = parseModelsResponse(body);
    if (!models) {
      return {
        available: false,
        baseURL,
        error: "unexpected /v1/models response shape",
      };
    }

    return { available: true, baseURL, models };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { available: false, baseURL, error: message };
  } finally {
    clearTimeout(timer);
  }
}
