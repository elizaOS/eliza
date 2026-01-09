/**
 * @fileoverview Inference Provider Detection and Validation
 *
 * Detects available inference providers and ensures tests have access to
 * real inference capabilities. Throws errors if no provider is found.
 */

import { logger } from "../logger";

/** Default Ollama endpoint */
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

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
  /** Any error message if provider check failed */
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
 * Check if Ollama is available and list its models
 */
async function checkOllama(): Promise<InferenceProviderInfo> {
  try {
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

    const data = (await response.json()) as {
      models?: Array<{ name: string }>;
    };
    const models = data.models?.map((m) => m.name) ?? [];

    return {
      name: "ollama",
      available: true,
      endpoint: OLLAMA_URL,
      models,
    };
  } catch (error) {
    return {
      name: "ollama",
      available: false,
      endpoint: OLLAMA_URL,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Check if OpenAI API is configured
 */
function checkOpenAI(): InferenceProviderInfo {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    return {
      name: "openai",
      available: true,
      endpoint: "https://api.openai.com/v1",
    };
  }
  return {
    name: "openai",
    available: false,
    error: "OPENAI_API_KEY not set",
  };
}

/**
 * Check if Anthropic API is configured
 */
function checkAnthropic(): InferenceProviderInfo {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    return {
      name: "anthropic",
      available: true,
      endpoint: "https://api.anthropic.com",
    };
  }
  return {
    name: "anthropic",
    available: false,
    error: "ANTHROPIC_API_KEY not set",
  };
}

/**
 * Check if Google AI API is configured
 */
function checkGoogleAI(): InferenceProviderInfo {
  const apiKey = process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_API_KEY;
  if (apiKey) {
    return {
      name: "google",
      available: true,
      endpoint: "https://generativelanguage.googleapis.com",
    };
  }
  return {
    name: "google",
    available: false,
    error: "GOOGLE_API_KEY not set",
  };
}

/**
 * Detect all available inference providers
 */
export async function detectInferenceProviders(): Promise<InferenceProviderDetectionResult> {
  const providers: InferenceProviderInfo[] = [];

  // Check cloud providers first (faster, no network timeout)
  const openai = checkOpenAI();
  const anthropic = checkAnthropic();
  const google = checkGoogleAI();

  providers.push(openai, anthropic, google);

  // Check Ollama (requires network call)
  const ollama = await checkOllama();
  providers.push(ollama);

  // Find available providers
  const availableProviders = providers.filter((p) => p.available);
  const hasProvider = availableProviders.length > 0;

  // Determine primary provider (prefer cloud providers for reliability)
  let primaryProvider: InferenceProviderInfo | null = null;
  if (openai.available) {
    primaryProvider = openai;
  } else if (anthropic.available) {
    primaryProvider = anthropic;
  } else if (google.available) {
    primaryProvider = google;
  } else if (ollama.available) {
    primaryProvider = ollama;
  }

  // Build summary message
  let summary: string;
  if (!hasProvider) {
    summary =
      "NO INFERENCE PROVIDER AVAILABLE\n" +
      "   Integration tests require a working inference provider.\n\n" +
      "   Options:\n" +
      "   1. Start Ollama locally: ollama serve\n" +
      "   2. Set OPENAI_API_KEY environment variable\n" +
      "   3. Set ANTHROPIC_API_KEY environment variable\n" +
      "   4. Set GOOGLE_API_KEY environment variable";
  } else {
    const providerList = availableProviders
      .map((p) => {
        let info = `   - ${p.name.toUpperCase()}`;
        if (p.endpoint) info += ` (${p.endpoint})`;
        if (p.models?.length) info += ` - ${p.models.length} models`;
        return info;
      })
      .join("\n");

    summary =
      `Using inference provider: ${primaryProvider?.name.toUpperCase() ?? "NONE"}\n` +
      `   Available providers:\n${providerList}`;
  }

  return {
    hasProvider,
    primaryProvider,
    allProviders: providers,
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
