/**
 * @fileoverview Inference Provider Detection and Validation
 *
 * Detects available inference providers and ensures tests have access to
 * real inference capabilities. Throws errors if no provider is found.
 */

import { z } from "zod";
import { logger } from "../logger";

/** Default Ollama endpoint */
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

/**
 * Schema for Ollama /api/tags response
 */
const ollamaTagsResponseSchema = z.object({
  models: z.array(z.object({ name: z.string() })).optional(),
});

/**
 * Detected inference provider information
 */
export interface InferenceProviderInfo {
  /** Provider name (e.g., "ollama", "openai", "anthropic") */
  name: string;
  /** Whether the provider is available */
  available: boolean;
  /** Endpoint URL if applicable */
  endpoint?: string;
  /** Available models if detectable */
  models?: string[];
  /** Error message if provider check failed */
  error?: string;
}

/**
 * Result of inference provider detection
 */
export interface InferenceProviderDetectionResult {
  /** Whether any inference provider is available */
  hasProvider: boolean;
  /** The primary provider to use */
  primaryProvider: InferenceProviderInfo | null;
  /** All detected providers */
  allProviders: InferenceProviderInfo[];
  /** Summary message for logging */
  summary: string;
}

/**
 * Configuration for a cloud provider check
 */
interface CloudProviderConfig {
  name: string;
  envVars: string[];
  endpoint: string;
}

const CLOUD_PROVIDERS: CloudProviderConfig[] = [
  {
    name: "openai",
    envVars: ["OPENAI_API_KEY"],
    endpoint: "https://api.openai.com/v1",
  },
  {
    name: "anthropic",
    envVars: ["ANTHROPIC_API_KEY"],
    endpoint: "https://api.anthropic.com",
  },
  {
    name: "google",
    envVars: ["GOOGLE_API_KEY", "GOOGLE_AI_API_KEY"],
    endpoint: "https://generativelanguage.googleapis.com",
  },
];

/**
 * Check if a cloud provider is configured by checking for API key
 */
function checkCloudProvider(
  config: CloudProviderConfig,
): InferenceProviderInfo {
  const hasKey = config.envVars.some((envVar) => Boolean(process.env[envVar]));

  if (hasKey) {
    return {
      name: config.name,
      available: true,
      endpoint: config.endpoint,
    };
  }

  return {
    name: config.name,
    available: false,
    error: `${config.envVars.join(" or ")} not set`,
  };
}

/**
 * Check if Ollama is available and list its models
 */
async function checkOllama(): Promise<InferenceProviderInfo> {
  const response = await fetch(`${OLLAMA_URL}/api/tags`, {
    method: "GET",
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    return {
      name: "ollama",
      available: false,
      endpoint: OLLAMA_URL,
      error: `Ollama returned status ${response.status}`,
    };
  }

  const rawData: unknown = await response.json();
  const parseResult = ollamaTagsResponseSchema.safeParse(rawData);

  if (!parseResult.success) {
    return {
      name: "ollama",
      available: false,
      endpoint: OLLAMA_URL,
      error: `Invalid response from Ollama: ${(parseResult.error as { issues?: Array<{ message: string }>; toString: () => string }).issues?.[0]?.message || parseResult.error.toString() || "Validation failed"}`,
    };
  }

  const parseResultDataModels = parseResult.data.models;
  const models =
    parseResultDataModels?.map((m: { name: string }) => m.name) ?? [];

  return {
    name: "ollama",
    available: true,
    endpoint: OLLAMA_URL,
    models,
  };
}

/**
 * Safely check Ollama, catching network errors
 */
async function safeCheckOllama(): Promise<InferenceProviderInfo> {
  try {
    return await checkOllama();
  } catch (error) {
    return {
      name: "ollama",
      available: false,
      endpoint: OLLAMA_URL,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Build summary message for logging
 */
function buildSummary(
  availableProviders: InferenceProviderInfo[],
  primaryProvider: InferenceProviderInfo | null,
): string {
  if (availableProviders.length === 0) {
    return (
      "NO INFERENCE PROVIDER AVAILABLE\n" +
      "   Integration tests require a working inference provider.\n\n" +
      "   Options:\n" +
      "   1. Start Ollama locally: ollama serve\n" +
      "   2. Set OPENAI_API_KEY environment variable\n" +
      "   3. Set ANTHROPIC_API_KEY environment variable\n" +
      "   4. Set GOOGLE_API_KEY environment variable"
    );
  }

  const providerList = availableProviders
    .map((p) => {
      let info = `   - ${p.name.toUpperCase()}`;
      if (p.endpoint) info += ` (${p.endpoint})`;
      const pModels = p.models;
      if (pModels?.length) info += ` - ${pModels.length} models`;
      return info;
    })
    .join("\n");

  const primaryProviderName = primaryProvider?.name;
  return (
    `Using inference provider: ${primaryProviderName ? primaryProviderName.toUpperCase() : "NONE"}\n` +
    `   Available providers:\n${providerList}`
  );
}

/**
 * Detect all available inference providers
 */
export async function detectInferenceProviders(): Promise<InferenceProviderDetectionResult> {
  // Check all cloud providers
  const cloudProviders = CLOUD_PROVIDERS.map(checkCloudProvider);

  // Check Ollama (requires network call)
  const ollama = await safeCheckOllama();

  const allProviders = [...cloudProviders, ollama];
  const availableProviders = allProviders.filter((p) => p.available);
  const hasProvider = availableProviders.length > 0;

  // Determine primary provider (prefer cloud providers for reliability)
  let primaryProvider: InferenceProviderInfo | null = null;
  for (const provider of allProviders) {
    if (provider.available) {
      primaryProvider = provider;
      break;
    }
  }

  const summary = buildSummary(availableProviders, primaryProvider);

  return {
    hasProvider,
    primaryProvider,
    allProviders,
    summary,
  };
}

/**
 * Validate that an inference provider is available for testing.
 * Throws an error with helpful instructions if no provider is found.
 */
export async function requireInferenceProvider(): Promise<InferenceProviderInfo> {
  const detection = await detectInferenceProviders();

  // Log the detection result
  console.log(`\n${"=".repeat(60)}`);
  console.log("INFERENCE PROVIDER DETECTION");
  console.log("=".repeat(60));
  console.log(detection.summary);
  console.log(`${"=".repeat(60)}\n`);

  if (!detection.hasProvider || !detection.primaryProvider) {
    throw new Error(
      "No inference provider available for integration tests.\n\n" +
        "Integration tests require a working inference provider.\n\n" +
        "Options:\n" +
        "  1. Start Ollama locally:\n" +
        "     $ ollama serve\n" +
        "     $ ollama pull llama3.2:1b  # for TEXT_SMALL\n" +
        "     $ ollama pull llama3.2:3b  # for TEXT_LARGE\n" +
        "     $ ollama pull nomic-embed-text  # for embeddings\n\n" +
        "  2. Set a cloud API key:\n" +
        "     $ export OPENAI_API_KEY=sk-...\n" +
        "     $ export ANTHROPIC_API_KEY=sk-...\n" +
        "     $ export GOOGLE_API_KEY=...\n",
    );
  }

  logger.info(
    { src: "testing", provider: detection.primaryProvider.name },
    `Using ${detection.primaryProvider.name} for test inference`,
  );

  return detection.primaryProvider;
}

/**
 * Check if any inference provider is available without throwing
 */
export async function hasInferenceProvider(): Promise<boolean> {
  const detection = await detectInferenceProviders();
  return detection.hasProvider;
}
