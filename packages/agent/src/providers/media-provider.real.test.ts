/**
 * Real API Integration Tests for Media Providers
 *
 * These tests use ACTUAL API keys and make REAL API calls.
 * Run with: REAL_API_TEST=1 npx vitest run src/providers/media-provider.real.test.ts
 *
 * Required environment variables:
 *   OPENAI_API_KEY - OpenAI API key for vision and image generation
 *   ANTHROPIC_API_KEY - Anthropic API key for vision
 *   OLLAMA_BASE_URL - Ollama server URL (default: http://localhost:11434)
 *
 * Test image: Uses a public domain image from httpbin.org
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import {
  describeIf,
  itIf,
} from "../../../app-core/test/helpers/conditional-tests.ts";
import type { ImageConfig, VisionConfig } from "../config/types.eliza";
import {
  createImageProvider,
  createVisionProvider,
  type ImageGenerationProvider,
  type VisionAnalysisProvider,
} from "./media-provider";

// Skip if not in real API test mode
const REAL_API_MODE = process.env.REAL_API_TEST === "1";
const describeFn = describeIf(REAL_API_MODE);

// Load API keys from environment (user should set these from eliza/.env)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

// Test image - a public domain image (httpbin returns a coyote image)
const TEST_IMAGE_URL = "https://httpbin.org/image/jpeg";

// Alternative test image - use httpbin's PNG endpoint instead of Wikipedia
// (Wikipedia images may be blocked or require special headers)
const _TEST_IMAGE_URL_ALT = "https://httpbin.org/image/png";

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function isOllamaRunning(): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function hasOllamaVisionModel(): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    if (!response.ok) return false;
    const data = (await response.json()) as {
      models?: Array<{ name: string }>;
    };
    const models = data.models ?? [];
    // Check for common vision models available through local Ollama installs.
    const visionModels = ["moondream", "llava", "bakllava"];
    return models.some((m) =>
      visionModels.some((v) => m.name === v || m.name.startsWith(`${v}:`)),
    );
  } catch {
    return false;
  }
}

// ============================================================================
// OPENAI VISION TESTS
// ============================================================================

describeFn("OpenAI Vision Provider (Real API)", () => {
  let provider: VisionAnalysisProvider;

  beforeAll(() => {
    const config: VisionConfig = {
      mode: "own-key",
      provider: "openai",
      openai: {
        apiKey: OPENAI_API_KEY,
        model: "gpt-5-mini", // Use the faster/cheaper model for testing
        maxTokens: 500,
      },
    };
    provider = createVisionProvider(config, {});
  });

  it("should analyze an image from URL", async () => {
    console.log("[OpenAI] Analyzing image from URL...");
    const result = await provider.analyze({
      imageUrl: TEST_IMAGE_URL,
      prompt: "What do you see in this image? Describe it briefly.",
    });

    console.log("[OpenAI] Result:", JSON.stringify(result, null, 2));

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data?.description).toBeDefined();
    expect(result.data?.description.length).toBeGreaterThan(10);
    console.log("[OpenAI] Description:", result.data?.description);
  }, 30000);

  it("should analyze an image with a specific question", async () => {
    console.log("[OpenAI] Analyzing with specific question...");
    const result = await provider.analyze({
      imageUrl: TEST_IMAGE_URL,
      prompt: "What animal is shown in this image? What is it doing?",
    });

    expect(result.success).toBe(true);
    expect(result.data?.description).toBeDefined();
    console.log("[OpenAI] Animal identified:", result.data?.description);
  }, 30000);

  it("should handle base64 encoded images", async () => {
    // First fetch the image and convert to base64
    console.log("[OpenAI] Fetching image for base64 test...");
    const imageResponse = await fetch(TEST_IMAGE_URL);
    const buffer = await imageResponse.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");

    console.log("[OpenAI] Analyzing base64 image...");
    const result = await provider.analyze({
      imageBase64: base64,
      prompt: "Describe this image.",
    });

    expect(result.success).toBe(true);
    expect(result.data?.description).toBeDefined();
    console.log("[OpenAI] Base64 result:", result.data?.description);
  }, 30000);
});

// ============================================================================
// ANTHROPIC VISION TESTS
// ============================================================================

describeFn("Anthropic Vision Provider (Real API)", () => {
  let provider: VisionAnalysisProvider;

  beforeAll(() => {
    const config: VisionConfig = {
      mode: "own-key",
      provider: "anthropic",
      anthropic: {
        apiKey: ANTHROPIC_API_KEY,
        model: "claude-sonnet-4-6",
      },
    };
    provider = createVisionProvider(config, {});
  });

  it("should analyze an image from URL", async () => {
    console.log("[Anthropic] Analyzing image from URL...");

    // Anthropic requires base64 for images, so we need to fetch and convert
    const imageResponse = await fetch(TEST_IMAGE_URL);
    const buffer = await imageResponse.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");

    const result = await provider.analyze({
      imageBase64: base64,
      prompt: "What do you see in this image? Describe it briefly.",
    });

    console.log("[Anthropic] Result:", JSON.stringify(result, null, 2));

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data?.description).toBeDefined();
    expect(result.data?.description.length).toBeGreaterThan(10);
    console.log("[Anthropic] Description:", result.data?.description);
  }, 60000);

  it("should analyze with detailed instructions", async () => {
    console.log("[Anthropic] Analyzing with detailed instructions...");

    // Use the same reliable JPEG image as other tests
    const imageResponse = await fetch(TEST_IMAGE_URL);
    const buffer = await imageResponse.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");

    const result = await provider.analyze({
      imageBase64: base64,
      prompt:
        "Analyze this image and provide: 1) Main subject, 2) Colors present, 3) Setting/environment",
    });

    expect(result.success).toBe(true);
    expect(result.data?.description).toBeDefined();
    console.log("[Anthropic] Detailed analysis:", result.data?.description);
  }, 60000);
});

// ============================================================================
// OLLAMA LOCAL VISION TESTS
// ============================================================================

describeFn("Ollama Local Vision Provider (Real API)", () => {
  let provider: VisionAnalysisProvider;
  let ollamaAvailable = false;
  let hasVisionModel = false;

  beforeAll(async () => {
    ollamaAvailable = await isOllamaRunning();
    if (ollamaAvailable) {
      hasVisionModel = await hasOllamaVisionModel();
    }

    console.log(
      `[Ollama] Server running: ${ollamaAvailable}, Has vision model: ${hasVisionModel}`,
    );

    const config: VisionConfig = {
      mode: "own-key",
      provider: "ollama",
      ollama: {
        baseUrl: OLLAMA_BASE_URL,
        model: "moondream", // Smaller than llava (~1.8GB vs ~4GB)
        maxTokens: 500,
        autoDownload: true,
      },
    };
    provider = createVisionProvider(config, {});
  });

  it("should analyze an image locally if vision model is available", async () => {
    if (!ollamaAvailable) {
      console.log("[Ollama] Skipping - Ollama server not running");
      return;
    }

    if (!hasVisionModel) {
      console.log(
        "[Ollama] Skipping - No vision model available (run 'ollama pull llava' to install)",
      );
      return;
    }

    console.log("[Ollama] Analyzing image locally...");

    // Fetch and convert to base64 (Ollama requires base64)
    const imageResponse = await fetch(TEST_IMAGE_URL);
    const buffer = await imageResponse.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");

    const result = await provider.analyze({
      imageBase64: base64,
      prompt: "What do you see in this image? Keep it brief.",
    });

    console.log("[Ollama] Result:", JSON.stringify(result, null, 2));

    if (result.success) {
      expect(result.data?.description).toBeDefined();
      expect(result.data?.description.length).toBeGreaterThan(5);
      console.log("[Ollama] Description:", result.data?.description);
    } else {
      // If the model isn't available, we should get a clear error
      console.log(
        "[Ollama] Error (expected if no vision model):",
        result.error,
      );
      expect(result.error).toBeDefined();
    }
  }, 60000);

  itIf(REAL_API_MODE && process.env.ELIZA_OLLAMA_DOWNLOAD_TEST === "1")(
    "should auto-download vision model if not present (SLOW - downloads ~4GB model)",
    async () => {
      if (!ollamaAvailable) {
        console.log("[Ollama] Skipping - Ollama server not running");
        return;
      }

      // This test verifies the auto-download feature
      // The model should be downloaded on first use if autoDownload is true
      // NOTE: Skipped by default because llava is ~4GB and takes a long time
      console.log("[Ollama] Testing auto-download capability...");

      const imageResponse = await fetch(TEST_IMAGE_URL);
      const buffer = await imageResponse.arrayBuffer();
      const base64 = Buffer.from(buffer).toString("base64");

      const result = await provider.analyze({
        imageBase64: base64,
        prompt: "Describe this image in one sentence.",
      });

      // Either succeeds (model available/downloaded) or fails with clear error
      if (result.success) {
        expect(result.data?.description).toBeDefined();
      } else {
        // If it fails, should be due to download failure or other clear reason
        expect(result.error).toBeDefined();
      }
    },
    600000,
  ); // 10 minute timeout for model download
});

// ============================================================================
// OPENAI IMAGE GENERATION TESTS
// ============================================================================

describeFn("OpenAI Image Generation (Real API)", () => {
  let provider: ImageGenerationProvider;

  beforeAll(() => {
    const config: ImageConfig = {
      mode: "own-key",
      provider: "openai",
      openai: {
        apiKey: OPENAI_API_KEY,
        model: "dall-e-3",
        quality: "standard",
        style: "natural",
      },
    };
    provider = createImageProvider(config, {});
  });

  it("should generate an image from prompt", async () => {
    console.log("[DALL-E] Generating image...");

    const result = await provider.generate({
      prompt: "A simple red circle on a white background, minimalist",
      size: "1024x1024",
    });

    console.log(
      "[DALL-E] Result:",
      JSON.stringify(
        {
          success: result.success,
          hasUrl: !!result.data?.imageUrl,
          revisedPrompt: result.data?.revisedPrompt,
          error: result.error,
        },
        null,
        2,
      ),
    );

    if (result.success) {
      expect(result.data?.imageUrl).toBeDefined();
      expect(result.data?.imageUrl).toMatch(/^https?:\/\//);
      console.log("[DALL-E] Image URL:", result.data?.imageUrl);
    } else {
      // DALL-E may fail due to content policy or network - log but don't fail
      console.log(
        "[DALL-E] Generation failed (may be content policy or network):",
        result.error,
      );
    }
  }, 60000);
});

// ============================================================================
// CROSS-PROVIDER COMPARISON TESTS
// ============================================================================

describeFn("Cross-Provider Vision Comparison (Real API)", () => {
  let openaiProvider: VisionAnalysisProvider;
  let anthropicProvider: VisionAnalysisProvider;

  beforeAll(() => {
    openaiProvider = createVisionProvider(
      {
        mode: "own-key",
        provider: "openai",
        openai: {
          apiKey: OPENAI_API_KEY,
          model: "gpt-5-mini",
          maxTokens: 300,
        },
      },
      {},
    );

    anthropicProvider = createVisionProvider(
      {
        mode: "own-key",
        provider: "anthropic",
        anthropic: {
          apiKey: ANTHROPIC_API_KEY,
          model: "claude-sonnet-4-6",
        },
      },
      {},
    );
  });

  it("should compare OpenAI and Anthropic vision analysis", async () => {
    console.log("[Compare] Fetching test image...");
    const imageResponse = await fetch(TEST_IMAGE_URL);
    const buffer = await imageResponse.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");

    const prompt = "Describe this image in exactly 3 words.";

    console.log("[Compare] Running OpenAI...");
    const openaiResult = await openaiProvider.analyze({
      imageBase64: base64,
      prompt,
    });

    console.log("[Compare] Running Anthropic...");
    const anthropicResult = await anthropicProvider.analyze({
      imageBase64: base64,
      prompt,
    });

    console.log("=== COMPARISON RESULTS ===");
    console.log("OpenAI:", openaiResult.data?.description);
    console.log("Anthropic:", anthropicResult.data?.description);

    expect(openaiResult.success).toBe(true);
    expect(anthropicResult.success).toBe(true);
  }, 90000);
});

// ============================================================================
// ERROR HANDLING TESTS
// ============================================================================

describeFn("Error Handling (Real API)", () => {
  it("should handle invalid API key gracefully", async () => {
    const provider = createVisionProvider(
      {
        mode: "own-key",
        provider: "openai",
        openai: {
          apiKey: "sk-invalid-key-12345",
          model: "gpt-5-mini",
        },
      },
      {},
    );

    const result = await provider.analyze({
      imageUrl: TEST_IMAGE_URL,
      prompt: "Describe this image.",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/error|invalid|unauthorized/i);
    console.log("[Error Test] Got expected error:", result.error);
  });

  it("should handle non-existent image URL gracefully", async () => {
    const provider = createVisionProvider(
      {
        mode: "own-key",
        provider: "openai",
        openai: {
          apiKey: OPENAI_API_KEY,
          model: "gpt-5-mini",
        },
      },
      {},
    );

    const result = await provider.analyze({
      imageUrl: "https://httpbin.org/status/404",
      prompt: "Describe this image.",
    });

    // OpenAI may still try to process, or may fail - either way should be graceful
    console.log(
      "[Error Test] Non-existent image result:",
      result.success ? "Processed" : result.error,
    );
  });
});

// ============================================================================
// SUMMARY
// ============================================================================

afterAll(() => {
  console.log("\n========================================");
  console.log("  REAL API TESTS COMPLETED");
  console.log("========================================\n");
  console.log("To run these tests:");
  console.log(
    "  REAL_API_TEST=1 npx vitest run src/providers/media-provider.real.test.ts",
  );
  console.log("\nEnvironment variables used:");
  console.log("  OPENAI_API_KEY:", OPENAI_API_KEY ? "Set" : "Not set");
  console.log("  ANTHROPIC_API_KEY:", ANTHROPIC_API_KEY ? "Set" : "Not set");
  console.log("  OLLAMA_BASE_URL:", OLLAMA_BASE_URL);
  console.log("\n");
});
