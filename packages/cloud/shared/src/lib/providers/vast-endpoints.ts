/**
 * Resolves configured Vast model endpoints and fallback routing for provider factories.
 * Present malformed maps fail explicitly; absent maps retain environment/default routing.
 */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
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

const EndpointEntrySchema = z.union([
  z.string().min(1),
  z
    .object({
      baseUrl: z.string().min(1).optional(),
      url: z.string().min(1).optional(),
      apiKey: z.string().min(1).optional(),
      apiKeyEnv: z.string().min(1).optional(),
      apiModelId: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
    })
    .strict()
    .refine((value) => Boolean(value.baseUrl || value.url)),
]);
const EndpointMapSchema = z.record(z.string(), EndpointEntrySchema);
const FallbackMapSchema = z.record(z.string(), z.string().min(1));
type VastEndpointJsonValue = z.infer<typeof EndpointEntrySchema>;

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

function parseConfiguredMap<T>(raw: string | null, variable: string, schema: z.ZodType<T>): T {
  let parsed: unknown = {};
  if (raw?.trim()) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      // error-policy:J3 configuration is invalid; parser messages can contain credentials.
      throw new ElizaError(`Invalid JSON in ${variable}`, {
        code: "INVALID_VAST_ROUTING_CONFIG",
        context: { variable },
        cause: new SyntaxError("Configured routing map contains invalid JSON"),
      });
    }
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ElizaError(`Invalid routing map in ${variable}`, {
      code: "INVALID_VAST_ROUTING_CONFIG",
      context: { variable },
      cause: new TypeError("Configured routing map does not match its expected field types"),
    });
  }
  return result.data;
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
  const endpointMap = parseConfiguredMap(
    reader("VAST_ENDPOINTS_JSON"),
    "VAST_ENDPOINTS_JSON",
    EndpointMapSchema,
  );
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
  const rawMap = parseConfiguredMap(
    reader("VAST_FALLBACK_MODEL_MAP_JSON"),
    "VAST_FALLBACK_MODEL_MAP_JSON",
    FallbackMapSchema,
  );
  const fallback =
    rawMap[model] ??
    (model === "vast/eliza-1-27b-256k"
      ? "vast/eliza-1-27b"
      : model === "vast/eliza-1-27b"
        ? "vast/eliza-1-9b"
        : model === "vast/eliza-1-9b"
          ? "vast/eliza-1-2b"
          : null);

  if (!fallback || fallback === model || !isVastNativeModel(fallback)) return null;
  return hasDedicatedVastEndpointConfigured(fallback, reader) ? fallback : null;
}
