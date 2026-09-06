// Defines cloud shared vast endpoints behavior for backend service consumers.
import { getVastApiModelId, isVastNativeModel, VAST_NATIVE_MODELS } from "../models";
import { getProviderKey } from "./provider-env";

export interface VastEndpointConfig {
  model: string;
  apiKey: string;
  baseUrl: string;
  apiModelId: string;
  source: "model-env" | "json" | "global";
}

type EnvReader = (name: string) => string | null;

type VastEndpointJsonValue =
  | string
  | {
      baseUrl?: string;
      url?: string;
      apiKey?: string;
      apiKeyEnv?: string;
      apiModelId?: string;
      model?: string;
    };

const VAST_ENDPOINT_STRING_FIELDS = [
  "baseUrl",
  "url",
  "apiKey",
  "apiKeyEnv",
  "apiModelId",
  "model",
] as const;

/**
 * Raised when a Vast endpoint or fallback map env var is present but malformed.
 * Thrown at parse time so the provider factory fails fast with an actionable,
 * credential-free message instead of silently routing through the global
 * default or surfacing an opaque low-level error deep in dispatch. Messages
 * describe the offending env var, entry key, and value *type* only; raw values
 * (which can embed API keys) are never echoed.
 */
export class VastEndpointConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VastEndpointConfigError";
  }
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function vastModelEnvSuffix(model: string): string {
  return model
    .replace(/^vast\//, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function defaultApiModelId(model: string): string {
  const translated = getVastApiModelId(model);
  if (translated !== model) return translated;
  if (model.startsWith("vast/")) return model.slice("vast/".length);
  return translated;
}

/**
 * Parse a configured JSON map env var into a validated object. Absence (null or
 * blank) is legal and yields an empty map. A present-but-malformed value throws
 * a `VastEndpointConfigError` so misconfiguration fails fast before dispatch.
 */
function parseConfiguredMap(
  envName: string,
  raw: string | null,
  validateEntry: (key: string, value: unknown) => void,
): Record<string, unknown> {
  if (raw === null || raw.trim().length === 0) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // error-policy:J3 present-but-invalid JSON is untrusted input; surface an
    // explicit typed configuration error instead of a fake-empty map.
    throw new VastEndpointConfigError(
      `${envName} is set but is not valid JSON. Provide a JSON object mapping model ids to endpoint configuration, or unset the variable.`,
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new VastEndpointConfigError(
      `${envName} is set but is not a JSON object (received ${describeType(parsed)}). Provide a JSON object mapping model ids to endpoint configuration, or unset the variable.`,
    );
  }

  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    validateEntry(key, value);
  }
  return parsed as Record<string, unknown>;
}

function validateEndpointEntry(envName: string, key: string, value: unknown): void {
  if (typeof value === "string") return;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new VastEndpointConfigError(
      `${envName} entry for "${key}" must be a string base URL or an object, but received ${describeType(value)}.`,
    );
  }
  const record = value as Record<string, unknown>;
  for (const field of VAST_ENDPOINT_STRING_FIELDS) {
    const fieldValue = record[field];
    if (fieldValue !== undefined && typeof fieldValue !== "string") {
      throw new VastEndpointConfigError(
        `${envName} entry for "${key}" has an invalid "${field}" field: expected a string but received ${describeType(fieldValue)}.`,
      );
    }
  }
}

function validateFallbackEntry(envName: string, key: string, value: unknown): void {
  if (typeof value !== "string") {
    throw new VastEndpointConfigError(
      `${envName} entry for "${key}" must map to a fallback model id string, but received ${describeType(value)}.`,
    );
  }
}

function parseEndpointMap(
  envName: string,
  raw: string | null,
): Record<string, VastEndpointJsonValue> {
  return parseConfiguredMap(envName, raw, (key, value) =>
    validateEndpointEntry(envName, key, value),
  ) as Record<string, VastEndpointJsonValue>;
}

function parseFallbackModelMap(envName: string, raw: string | null): Record<string, string> {
  return parseConfiguredMap(envName, raw, (key, value) =>
    validateFallbackEntry(envName, key, value),
  ) as Record<string, string>;
}

function readJsonEndpoint(
  model: string,
  reader: EnvReader,
): {
  config: VastEndpointJsonValue;
  apiKey?: string;
  baseUrl?: string;
  apiModelId?: string;
} | null {
  const endpointMap = parseEndpointMap("VAST_ENDPOINTS_JSON", reader("VAST_ENDPOINTS_JSON"));
  const config = endpointMap[model];
  if (!config) return null;
  if (typeof config === "string") {
    return { config, baseUrl: config };
  }
  const apiKey =
    config.apiKey ?? (config.apiKeyEnv ? (reader(config.apiKeyEnv) ?? undefined) : undefined);
  return {
    config,
    apiKey,
    baseUrl: config.baseUrl ?? config.url,
    apiModelId: config.apiModelId ?? config.model,
  };
}

export function resolveVastEndpointConfig(
  model: string,
  reader: EnvReader = getProviderKey,
): VastEndpointConfig | null {
  if (!isVastNativeModel(model)) return null;

  const suffix = vastModelEnvSuffix(model);
  const modelBaseUrl = reader(`VAST_BASE_URL_${suffix}`) ?? reader(`VAST_ENDPOINT_URL_${suffix}`);
  const modelApiKey = reader(`VAST_API_KEY_${suffix}`);
  const modelApiModelId = reader(`VAST_API_MODEL_${suffix}`);

  if (modelBaseUrl) {
    const apiKey = modelApiKey ?? reader("VAST_API_KEY");
    if (!apiKey) return null;
    return {
      model,
      apiKey,
      baseUrl: trimTrailingSlash(modelBaseUrl),
      apiModelId: modelApiModelId ?? defaultApiModelId(model),
      source: "model-env",
    };
  }

  const jsonEndpoint = readJsonEndpoint(model, reader);
  if (jsonEndpoint?.baseUrl) {
    const apiKey = jsonEndpoint.apiKey ?? reader("VAST_API_KEY");
    if (!apiKey) return null;
    return {
      model,
      apiKey,
      baseUrl: trimTrailingSlash(jsonEndpoint.baseUrl),
      apiModelId: modelApiModelId ?? jsonEndpoint.apiModelId ?? defaultApiModelId(model),
      source: "json",
    };
  }

  const globalBaseUrl = reader("VAST_BASE_URL");
  const globalApiKey = reader("VAST_API_KEY");
  if (!globalBaseUrl || !globalApiKey) return null;
  return {
    model,
    apiKey: globalApiKey,
    baseUrl: trimTrailingSlash(globalBaseUrl),
    apiModelId: modelApiModelId ?? defaultApiModelId(model),
    source: "global",
  };
}

export function hasAnyVastProviderConfigured(reader: EnvReader = getProviderKey): boolean {
  return VAST_NATIVE_MODELS.some((model) => resolveVastEndpointConfig(model.id, reader));
}

export function hasDedicatedVastEndpointConfigured(
  model: string,
  reader: EnvReader = getProviderKey,
): boolean {
  const config = resolveVastEndpointConfig(model, reader);
  return Boolean(config && config.source !== "global");
}

export function resolveVastFallbackModel(
  model: string,
  reader: EnvReader = getProviderKey,
): string | null {
  if (!isVastNativeModel(model)) return null;
  const rawMap = parseFallbackModelMap(
    "VAST_FALLBACK_MODEL_MAP_JSON",
    reader("VAST_FALLBACK_MODEL_MAP_JSON"),
  );
  const mapped = rawMap[model];
  const fallback =
    typeof mapped === "string"
      ? mapped
      : model === "vast/eliza-1-27b-256k"
        ? "vast/eliza-1-27b"
        : model === "vast/eliza-1-27b"
          ? "vast/eliza-1-9b"
          : model === "vast/eliza-1-9b"
            ? "vast/eliza-1-2b"
            : null;

  if (!fallback || fallback === model || !isVastNativeModel(fallback)) return null;
  return hasDedicatedVastEndpointConfigured(fallback, reader) ? fallback : null;
}
