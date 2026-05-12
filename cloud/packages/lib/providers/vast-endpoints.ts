import { getVastApiModelId, isVastNativeModel, VAST_NATIVE_MODELS } from "@/lib/models";
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

function parseEndpointMap(raw: string | null): Record<string, VastEndpointJsonValue> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, VastEndpointJsonValue>;
  } catch {
    return {};
  }
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
  const endpointMap = parseEndpointMap(reader("VAST_ENDPOINTS_JSON"));
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
  const rawMap = parseEndpointMap(reader("VAST_FALLBACK_MODEL_MAP_JSON"));
  const fallback =
    typeof rawMap[model] === "string"
      ? (rawMap[model] as string)
      : model === "vast/eliza-1-27b"
        ? "vast/eliza-1-9b"
        : model === "vast/eliza-1-9b"
          ? "vast/eliza-1-2b"
          : null;

  if (!fallback || fallback === model || !isVastNativeModel(fallback)) return null;
  return hasDedicatedVastEndpointConfigured(fallback, reader) ? fallback : null;
}
