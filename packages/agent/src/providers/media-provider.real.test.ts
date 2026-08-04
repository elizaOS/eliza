/**
 * Real API Integration Tests for Media Providers
 *
 * These tests use ACTUAL API keys and make REAL API calls.
 * Run with: REAL_API_TEST=1 npx vitest run src/providers/media-provider.real.test.ts
 *
 * Required environment variables:
 *   OPENAI_API_KEY - OpenAI API key for vision and image generation
 *   ANTHROPIC_API_KEY - Anthropic API key for vision
 *
 * Test image: Uses a public domain image from httpbin.org
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIf } from "../../../app-core/test/helpers/conditional-tests.ts";
import type { VisionConfig } from "../config/types.eliza";
import {
  createVisionProvider,
  type VisionAnalysisProvider,
} from "./media-provider";

// Skip if not in real API test mode
const REAL_API_MODE = process.env.REAL_API_TEST === "1";
const describeFn = describeIf(REAL_API_MODE);

// Load API keys from environment (user should set these from eliza/.env)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

// Test image - a public domain image (httpbin returns a coyote image)
const TEST_IMAGE_URL = "https://httpbin.org/image/jpeg";

// Alternative test image - use httpbin's PNG endpoint instead of Wikipedia
// (Wikipedia images may be blocked or require special headers)
const _TEST_IMAGE_URL_ALT = "https://httpbin.org/image/png";

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
  console.log("\n");
});
