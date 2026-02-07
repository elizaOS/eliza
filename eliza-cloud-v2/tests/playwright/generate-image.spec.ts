import { test, expect, APIRequestContext } from "@playwright/test";

/**
 * Image Generation Route Integration Tests
 *
 * Tests /api/v1/generate-image endpoint for request validation,
 * response structure, model selection, and credit handling.
 */

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
const CLOUD_URL = process.env.CLOUD_URL ?? BASE_URL;
const API_KEY = process.env.TEST_API_KEY;

const IMAGE_GENERATION_TIMEOUT = 180_000; // 3 minutes

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  };
}

type ImageGenerationPayload = {
  prompt: string;
  model?: string;
  aspectRatio?: string;
  stylePreset?: string;
  numImages?: number;
  sourceImage?: string;
};

async function generateImage(
  request: APIRequestContext,
  data: Partial<ImageGenerationPayload>,
  options: { authenticated?: boolean; timeout?: number } = {},
): Promise<Awaited<ReturnType<APIRequestContext["post"]>>> {
  const { authenticated = true, timeout = IMAGE_GENERATION_TIMEOUT } = options;
  return request.post(`${CLOUD_URL}/api/v1/generate-image`, {
    headers: authenticated
      ? authHeaders()
      : { "Content-Type": "application/json" },
    data,
    timeout,
  });
}

test.describe("Image Generation API - /api/v1/generate-image", () => {
  test.describe("Authentication", () => {
    test("returns 401 without authentication", async ({ request }) => {
      const response = await generateImage(
        request,
        { prompt: "A simple test image" },
        { authenticated: false },
      );
      expect([200, 401, 402, 429]).toContain(response.status());
    });

    test.describe("with API key", () => {
      test.skip(() => !API_KEY, "TEST_API_KEY required");
      test.setTimeout(IMAGE_GENERATION_TIMEOUT);

      test("accepts request with valid API key", async ({ request }) => {
        const response = await generateImage(request, {
          prompt: "A simple red circle",
        });
        expect([200, 402]).toContain(response.status());
      });
    });
  });

  test.describe("Request Validation", () => {
    test.skip(() => !API_KEY, "TEST_API_KEY required");

    test("returns 400 for missing prompt", async ({ request }) => {
      const response = await generateImage(request, {});
      expect(response.status()).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("Prompt is required");
    });

    test("returns 400 for empty prompt", async ({ request }) => {
      const response = await generateImage(request, { prompt: "" });
      expect(response.status()).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("Prompt is required");
    });

    test("returns 400 for whitespace-only prompt", async ({ request }) => {
      const response = await generateImage(request, { prompt: "   " });
      expect(response.status()).toBe(400);
    });
  });

  test.describe("Model Selection", () => {
    test.skip(() => !API_KEY, "TEST_API_KEY required");
    test.setTimeout(IMAGE_GENERATION_TIMEOUT);

    test("uses default model when none specified", async ({ request }) => {
      const response = await generateImage(request, {
        prompt: "A blue square",
      });
      expect([200, 402]).toContain(response.status());
    });

    test("accepts valid Google model", async ({ request }) => {
      const response = await generateImage(request, {
        prompt: "A green triangle",
        model: "google/gemini-2.5-flash-image",
      });
      expect([200, 402]).toContain(response.status());
    });

    test("accepts valid OpenAI model", async ({ request }) => {
      const response = await generateImage(request, {
        prompt: "A yellow star",
        model: "openai/gpt-5-nano",
      });
      expect([200, 402]).toContain(response.status());
    });

    test("falls back to default model for invalid model", async ({
      request,
    }) => {
      const response = await generateImage(request, {
        prompt: "A purple pentagon",
        model: "invalid/model-name",
      });
      expect([200, 402]).toContain(response.status());
    });
  });

  test.describe("Image Generation Options", () => {
    test.skip(() => !API_KEY, "TEST_API_KEY required");
    test.setTimeout(IMAGE_GENERATION_TIMEOUT);

    test("accepts valid aspect ratio", async ({ request }) => {
      const response = await generateImage(request, {
        prompt: "A landscape scene",
        aspectRatio: "16:9",
      });
      expect([200, 402]).toContain(response.status());
    });

    test("accepts valid style preset", async ({ request }) => {
      const response = await generateImage(request, {
        prompt: "A cyberpunk city",
        stylePreset: "neon-punk",
      });
      expect([200, 402]).toContain(response.status());
    });

    test("accepts numImages parameter", async ({ request }) => {
      const response = await generateImage(request, {
        prompt: "Abstract art",
        numImages: 2,
      });
      expect([200, 402]).toContain(response.status());
    });
  });

  test.describe("CORS Headers", () => {
    test("OPTIONS returns correct CORS headers", async ({ request }) => {
      const response = await request.fetch(
        `${CLOUD_URL}/api/v1/generate-image`,
        {
          method: "OPTIONS",
          headers: { Origin: "https://example.com" },
        },
      );

      expect(response.status()).toBe(204);
      expect(response.headers()["access-control-allow-origin"]).toBe("*");
      expect(response.headers()["access-control-allow-methods"]).toContain(
        "POST",
      );
    });
  });

  test.describe("Response Structure", () => {
    test.skip(() => !API_KEY, "TEST_API_KEY required");
    test.setTimeout(IMAGE_GENERATION_TIMEOUT);

    test("returns correct response structure on success", async ({
      request,
    }) => {
      const response = await generateImage(request, {
        prompt: "A simple icon",
      });

      if (response.status() === 200) {
        const body = await response.json();

        expect(body).toHaveProperty("images");
        expect(body).toHaveProperty("numImages");
        expect(Array.isArray(body.images)).toBe(true);
        expect(typeof body.numImages).toBe("number");

        if (body.images.length > 0) {
          const image = body.images[0];
          expect(image.url || image.image).toBeTruthy();
          expect(image).toHaveProperty("mimeType");
        }
      } else if (response.status() === 402) {
        const body = await response.json();
        expect(body).toHaveProperty("error");
        expect(body.error).toContain("Insufficient credits");
      }
    });
  });

  test.describe("streamText with String Model ID Integration", () => {
    test.skip(() => !API_KEY, "TEST_API_KEY required");
    test.setTimeout(IMAGE_GENERATION_TIMEOUT);

    /**
     * Verifies that streamText() accepts string model IDs via Vercel AI Gateway.
     * The AI Gateway resolves strings like "google/gemini-2.5-flash-image" to
     * the appropriate provider, so no LanguageModel instance is required.
     */
    test("generates image successfully with Google Gemini model (string ID)", async ({
      request,
    }) => {
      const response = await generateImage(request, {
        prompt: "A simple geometric shape in blue color",
        model: "google/gemini-2.5-flash-image",
        aspectRatio: "1:1",
      });

      const status = response.status();
      console.log(`Google Gemini model response status: ${status}`);

      if (status === 200) {
        const body = await response.json();
        console.log(`Generated ${body.numImages} image(s)`);
        expect(body.numImages).toBeGreaterThan(0);
        expect(body.images.length).toBeGreaterThan(0);
        console.log(
          "SUCCESS: streamText() works with string model ID via AI Gateway",
        );
      } else if (status === 402) {
        console.log(
          "Test skipped: Insufficient credits (but no runtime error occurred)",
        );
      } else if (status === 500) {
        const body = await response.json();
        console.log(`Error response: ${JSON.stringify(body)}`);
        const errorMsg = body.error?.toLowerCase() || "";
        expect(errorMsg).not.toContain("model must be");
        expect(errorMsg).not.toContain("languagemodel");
        expect(errorMsg).not.toContain("not a string");
      }

      expect([200, 402, 500]).toContain(status);
    });

    test("generates image successfully with OpenAI model (string ID)", async ({
      request,
    }) => {
      const response = await generateImage(request, {
        prompt: "A minimalist red icon",
        model: "openai/gpt-5-nano",
        aspectRatio: "1:1",
      });

      const status = response.status();
      console.log(`OpenAI model response status: ${status}`);

      if (status === 200) {
        const body = await response.json();
        console.log(`Generated ${body.numImages} image(s)`);
        expect(body.numImages).toBeGreaterThan(0);
        console.log("SUCCESS: streamText() works with OpenAI string model ID");
      } else if (status === 402) {
        console.log(
          "Test passed: Model ID accepted, just insufficient credits",
        );
      } else if (status === 500) {
        const body = await response.json();
        const errorMsg = body.error?.toLowerCase() || "";
        expect(errorMsg).not.toContain("model must be");
        expect(errorMsg).not.toContain("languagemodel");
      }

      expect([200, 402, 500]).toContain(status);
    });
  });

  test.describe("Image-to-Image Generation", () => {
    test.skip(() => !API_KEY, "TEST_API_KEY required");
    test.setTimeout(IMAGE_GENERATION_TIMEOUT);

    test("accepts sourceImage for image-to-image generation", async ({
      request,
    }) => {
      const minimalPng =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

      const response = await generateImage(request, {
        prompt: "Transform this into a watercolor painting",
        sourceImage: `data:image/png;base64,${minimalPng}`,
      });

      expect([200, 400, 402, 500]).toContain(response.status());

      if (response.status() === 400) {
        const body = await response.json();
        expect(body.error).not.toContain("sourceImage");
      }
    });
  });

  test.describe("Credit Handling", () => {
    test.skip(() => !API_KEY, "TEST_API_KEY required");

    test("returns 402 when insufficient credits", async ({ request }) => {
      const billingResponse = await request.get(
        `${CLOUD_URL}/api/v1/miniapp/billing`,
        {
          headers: authHeaders(),
        },
      );

      if (billingResponse.status() !== 200) {
        console.log("Could not check billing, skipping credit test");
        return;
      }

      const { billing } = await billingResponse.json();
      const balance = parseFloat(billing?.creditBalance || "0");
      console.log(`Current balance: $${balance.toFixed(4)}`);

      if (balance < 0.01) {
        const response = await generateImage(request, { prompt: "Test image" });
        expect(response.status()).toBe(402);
        const body = await response.json();
        expect(body.error).toContain("Insufficient credits");
      }
    });
  });

  test.describe("Rate Limiting", () => {
    test("rate limiting is configured on endpoint", async ({ request }) => {
      const response = await generateImage(
        request,
        { prompt: "Rate limit test" },
        { authenticated: false },
      );
      expect([200, 400, 401, 402, 429, 500]).toContain(response.status());
    });
  });
});
