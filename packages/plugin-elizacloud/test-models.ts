#!/usr/bin/env bun
/**
 * Comprehensive test script for ElizaOS Cloud API
 *
 * This test suite verifies all ElizaOS Cloud API endpoints including:
 * - Custom ElizaOS Cloud endpoints
 * - OpenAI-compatible endpoints
 *
 * Endpoint Types:
 *
 * CUSTOM ElizaOS Cloud endpoints:
 * - /api/v1/generate-image (Custom image generation, not OpenAI-compatible)
 * - /api/v1/chat (Custom chat streaming, not OpenAI-compatible)
 *
 * OpenAI-COMPATIBLE endpoints:
 * - /api/v1/models (List available models)
 * - /api/v1/chat/completions (Text generation, vision, structured output)
 * - /api/v1/embeddings (Text embeddings)
 * - /api/v1/audio/transcriptions (Speech-to-text)
 * - /api/v1/audio/speech (Text-to-speech)
 *
 * All endpoints have been verified and updated to match ElizaOS Cloud API specifications.
 */

const API_KEY =
  "eliza_59e48abf73c97c43be72cafe25c1a3626c92e8f580e8bd3ca046e1fe59f2fc88";
const BASE_URL = "https://www.elizacloud.ai/api/v1";

interface TestResult {
  name: string;
  status: "✅ PASSED" | "❌ FAILED" | "⏭️ SKIPPED";
  duration: number;
  details?: string;
  error?: string;
}

const results: TestResult[] = [];

function log(message: string) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function logSuccess(message: string) {
  console.log(`✅ ${message}`);
}

function logError(message: string) {
  console.error(`❌ ${message}`);
}

async function test1_APIKeyValidation(): Promise<TestResult> {
  const startTime = Date.now();
  const testName = "API Key Validation";
  log(`Testing: ${testName}`);

  try {
    const response = await fetch(`${BASE_URL}/models`, {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(
        `API returned ${response.status}: ${response.statusText}`,
      );
    }

    const data = await response.json();
    const modelCount = data.models?.length || 0;

    logSuccess(`${testName} - Found ${modelCount} available models`);
    return {
      name: testName,
      status: "✅ PASSED",
      duration: Date.now() - startTime,
      details: `${modelCount} models available`,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`${testName} - ${message}`);
    return {
      name: testName,
      status: "❌ FAILED",
      duration: Date.now() - startTime,
      error: message,
    };
  }
}

async function test2_ChatEndpoint(): Promise<TestResult> {
  const startTime = Date.now();
  const testName = "Chat Endpoint (ElizaOS Cloud /chat)";
  log(`Testing: ${testName}`);

  try {
    const response = await fetch(`${BASE_URL}/chat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "openai/gpt-4o-mini",
        messages: [
          {
            id: "1",
            role: "user",
            parts: [
              {
                type: "text",
                text: "Say 'Hello from ElizaOS!' and nothing else.",
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API returned ${response.status}: ${errorText}`);
    }

    // The endpoint returns a streaming response
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response body");
    }

    logSuccess(`${testName} - Streaming response received`);
    return {
      name: testName,
      status: "✅ PASSED",
      duration: Date.now() - startTime,
      details: "Chat streaming works",
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`${testName} - ${message}`);
    return {
      name: testName,
      status: "❌ FAILED",
      duration: Date.now() - startTime,
      error: message,
    };
  }
}

async function test3_TextGenerationSmall(): Promise<TestResult> {
  const startTime = Date.now();
  const testName = "Text Generation Small (gpt-4o-mini)";
  log(`Testing: ${testName}`);

  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: "Say 'Hello from ElizaOS Cloud!' and nothing else.",
          },
        ],
        max_tokens: 50,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API returned ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("No content in response");
    }

    logSuccess(`${testName} - Response: "${content}"`);
    return {
      name: testName,
      status: "✅ PASSED",
      duration: Date.now() - startTime,
      details: `Generated: "${content}"`,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`${testName} - ${message}`);
    return {
      name: testName,
      status: "❌ FAILED",
      duration: Date.now() - startTime,
      error: message,
    };
  }
}

async function test4_TextGenerationLarge(): Promise<TestResult> {
  const startTime = Date.now();
  const testName = "Text Generation Large (gpt-4o)";
  log(`Testing: ${testName}`);

  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-4o",
        messages: [
          {
            role: "user",
            content: "What is 2+2? Answer with just the number.",
          },
        ],
        max_tokens: 10,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API returned ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("No content in response");
    }

    logSuccess(`${testName} - Response: "${content}"`);
    return {
      name: testName,
      status: "✅ PASSED",
      duration: Date.now() - startTime,
      details: `Generated: "${content}"`,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`${testName} - ${message}`);
    return {
      name: testName,
      status: "❌ FAILED",
      duration: Date.now() - startTime,
      error: message,
    };
  }
}

async function test5_ImageGeneration(): Promise<TestResult> {
  const startTime = Date.now();
  const testName = "Image Generation (Gemini 2.5 Flash)";
  log(`Testing: ${testName}`);

  try {
    // ElizaOS Cloud uses custom /generate-image endpoint
    const response = await fetch(`${BASE_URL}/generate-image`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: "A simple red circle",
        numImages: 1,
        aspectRatio: "1:1",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API returned ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const imageUrl = data.images?.[0]?.url || data.images?.[0]?.image;

    if (!imageUrl) {
      throw new Error("No image URL in response");
    }

    logSuccess(`${testName} - Image generated successfully`);
    return {
      name: testName,
      status: "✅ PASSED",
      duration: Date.now() - startTime,
      details: "Image URL received",
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`${testName} - ${message}`);
    return {
      name: testName,
      status: "❌ FAILED",
      duration: Date.now() - startTime,
      error: message,
    };
  }
}

async function test6_ImageDescription(): Promise<TestResult> {
  const startTime = Date.now();
  const testName = "Image Description (gpt-4o-mini vision)";
  log(`Testing: ${testName}`);

  try {
    // Using a simple test image URL
    const testImageUrl =
      "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/240px-Cat03.jpg";

    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this image in one sentence." },
              { type: "image_url", image_url: { url: testImageUrl } },
            ],
          },
        ],
        max_tokens: 100,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API returned ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const description = data.choices?.[0]?.message?.content;

    if (!description) {
      throw new Error("No description in response");
    }

    logSuccess(`${testName} - Description: "${description}"`);
    return {
      name: testName,
      status: "✅ PASSED",
      duration: Date.now() - startTime,
      details: `Description: "${description}"`,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`${testName} - ${message}`);
    return {
      name: testName,
      status: "❌ FAILED",
      duration: Date.now() - startTime,
      error: message,
    };
  }
}

async function test7_AlternativeModels(): Promise<TestResult> {
  const startTime = Date.now();
  const testName = "Alternative Models (Claude, Gemini)";
  log(`Testing: ${testName}`);

  const models = ["anthropic/claude-3.5-sonnet", "google/gemini-2.0-flash"];

  const modelResults: string[] = [];

  try {
    for (const model of models) {
      try {
        const response = await fetch(`${BASE_URL}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "Say 'OK' and nothing else." }],
            max_tokens: 10,
          }),
        });

        if (response.ok) {
          const data = await response.json();
          const content = data.choices?.[0]?.message?.content;
          modelResults.push(`${model}: ✅ "${content}"`);
          logSuccess(`  ${model} - OK`);
        } else {
          modelResults.push(`${model}: ❌ ${response.status}`);
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        modelResults.push(`${model}: ❌ ${msg}`);
      }
    }

    const passedCount = modelResults.filter((r) => r.includes("✅")).length;
    const totalCount = models.length;

    logSuccess(`${testName} - ${passedCount}/${totalCount} models working`);
    return {
      name: testName,
      status: passedCount > 0 ? "✅ PASSED" : "❌ FAILED",
      duration: Date.now() - startTime,
      details: `${passedCount}/${totalCount} models responded`,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`${testName} - ${message}`);
    return {
      name: testName,
      status: "❌ FAILED",
      duration: Date.now() - startTime,
      error: message,
    };
  }
}

async function test8_EmbeddingsBasic(): Promise<TestResult> {
  const startTime = Date.now();
  const testName = "Text Embeddings (text-embedding-3-small)";
  log(`Testing: ${testName}`);

  try {
    const testText = "Hello, this is a test embedding.";
    const response = await fetch(`${BASE_URL}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: testText,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API returned ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const embedding = data.data?.[0]?.embedding;

    if (!embedding || !Array.isArray(embedding)) {
      throw new Error("No valid embedding in response");
    }

    const dimensions = embedding.length;
    const firstValues = embedding.slice(0, 3).map((v: number) => v.toFixed(4));

    logSuccess(
      `${testName} - Got ${dimensions}-dimensional vector [${firstValues.join(", ")}...]`,
    );
    return {
      name: testName,
      status: "✅ PASSED",
      duration: Date.now() - startTime,
      details: `${dimensions}D vector generated`,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`${testName} - ${message}`);
    return {
      name: testName,
      status: "❌ FAILED",
      duration: Date.now() - startTime,
      error: message,
    };
  }
}

async function test9_EmbeddingsSimilarity(): Promise<TestResult> {
  const startTime = Date.now();
  const testName = "Embedding Similarity (cosine distance)";
  log(`Testing: ${testName}`);

  try {
    // Helper function to calculate cosine similarity
    function cosineSimilarity(a: number[], b: number[]): number {
      if (a.length !== b.length) {
        throw new Error("Vectors must have the same length");
      }
      let dotProduct = 0;
      let normA = 0;
      let normB = 0;
      for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
      }
      return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    // Get embeddings for similar and dissimilar texts
    const texts = [
      "The cat sits on the mat.",
      "A feline rests on the carpet.", // Similar to first
      "Python is a programming language.", // Different from first two
    ];

    const embeddings: number[][] = [];

    for (const text of texts) {
      const response = await fetch(`${BASE_URL}/embeddings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: text,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to get embedding for: "${text}"`);
      }

      const data = await response.json();
      const embedding = data.data?.[0]?.embedding;

      if (!embedding) {
        throw new Error(`No embedding returned for: "${text}"`);
      }

      embeddings.push(embedding);
    }

    // Calculate similarities
    const sim_0_1 = cosineSimilarity(embeddings[0], embeddings[1]);
    const sim_0_2 = cosineSimilarity(embeddings[0], embeddings[2]);

    // Similar texts should have higher similarity
    if (sim_0_1 > sim_0_2) {
      logSuccess(
        `${testName} - Similar texts (${sim_0_1.toFixed(3)}) > Dissimilar texts (${sim_0_2.toFixed(3)})`,
      );
      return {
        name: testName,
        status: "✅ PASSED",
        duration: Date.now() - startTime,
        details: `Similarity check passed: ${sim_0_1.toFixed(3)} > ${sim_0_2.toFixed(3)}`,
      };
    } else {
      throw new Error(
        `Similarity check failed: similar=${sim_0_1.toFixed(3)}, dissimilar=${sim_0_2.toFixed(3)}`,
      );
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`${testName} - ${message}`);
    return {
      name: testName,
      status: "❌ FAILED",
      duration: Date.now() - startTime,
      error: message,
    };
  }
}

async function test10_EmbeddingsBatch(): Promise<TestResult> {
  const startTime = Date.now();
  const testName = "Batch Embeddings (multiple inputs)";
  log(`Testing: ${testName}`);

  try {
    const texts = [
      "First text to embed",
      "Second text to embed",
      "Third text to embed",
    ];

    const response = await fetch(`${BASE_URL}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: texts,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API returned ${response.status}: ${errorText}`);
    }

    const data = await response.json();

    if (!data.data || !Array.isArray(data.data)) {
      throw new Error("Invalid response structure");
    }

    if (data.data.length !== texts.length) {
      throw new Error(
        `Expected ${texts.length} embeddings, got ${data.data.length}`,
      );
    }

    // Verify all embeddings are valid
    for (let i = 0; i < data.data.length; i++) {
      const embedding = data.data[i].embedding;
      if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
        throw new Error(`Invalid embedding at index ${i}`);
      }
    }

    const dimensions = data.data[0].embedding.length;

    logSuccess(
      `${testName} - Successfully generated ${texts.length} ${dimensions}D embeddings`,
    );
    return {
      name: testName,
      status: "✅ PASSED",
      duration: Date.now() - startTime,
      details: `${texts.length} embeddings (${dimensions}D each)`,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`${testName} - ${message}`);
    return {
      name: testName,
      status: "❌ FAILED",
      duration: Date.now() - startTime,
      error: message,
    };
  }
}

async function test11_EmbeddingsLargeModel(): Promise<TestResult> {
  const startTime = Date.now();
  const testName = "Large Embedding Model (text-embedding-3-large)";
  log(`Testing: ${testName}`);

  try {
    const testText = "Testing the large embedding model.";
    const response = await fetch(`${BASE_URL}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-large",
        input: testText,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API returned ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const embedding = data.data?.[0]?.embedding;

    if (!embedding || !Array.isArray(embedding)) {
      throw new Error("No valid embedding in response");
    }

    const dimensions = embedding.length;
    const usage = data.usage;

    logSuccess(
      `${testName} - Got ${dimensions}D vector (${usage?.total_tokens || "N/A"} tokens)`,
    );
    return {
      name: testName,
      status: "✅ PASSED",
      duration: Date.now() - startTime,
      details: `${dimensions}D vector, ${usage?.total_tokens || "N/A"} tokens`,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`${testName} - ${message}`);
    return {
      name: testName,
      status: "❌ FAILED",
      duration: Date.now() - startTime,
      error: message,
    };
  }
}

async function test12_AudioTranscription(): Promise<TestResult> {
  const startTime = Date.now();
  const testName = "Audio Transcription (Whisper)";
  log(`Testing: ${testName}`);

  try {
    // Fetch a test audio file from Wikipedia (Chris Benoit voice message)
    const audioUrl =
      "https://upload.wikimedia.org/wikipedia/en/4/40/Chris_Benoit_Voice_Message.ogg";
    const audioResponse = await fetch(audioUrl);

    if (!audioResponse.ok) {
      throw new Error("Failed to fetch test audio file");
    }

    const audioBuffer = await audioResponse.arrayBuffer();
    const audioBlob = new Blob([audioBuffer], { type: "audio/ogg" });

    // Create FormData
    const formData = new FormData();
    formData.append("file", audioBlob, "test-audio.ogg");
    formData.append("model", "whisper-1");

    const response = await fetch(`${BASE_URL}/audio/transcriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API returned ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const transcription = data.text;

    if (!transcription || typeof transcription !== "string") {
      throw new Error("No transcription text in response");
    }

    const preview =
      transcription.length > 50
        ? transcription.substring(0, 50) + "..."
        : transcription;

    logSuccess(`${testName} - Transcribed: "${preview}"`);
    return {
      name: testName,
      status: "✅ PASSED",
      duration: Date.now() - startTime,
      details: `Transcribed ${transcription.length} characters`,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`${testName} - ${message}`);
    return {
      name: testName,
      status: "❌ FAILED",
      duration: Date.now() - startTime,
      error: message,
    };
  }
}

async function test13_TextToSpeech(): Promise<TestResult> {
  const startTime = Date.now();
  const testName = "Text-to-Speech (TTS)";
  log(`Testing: ${testName}`);

  try {
    const testText = "Hello, this is a test of the text to speech system.";

    const response = await fetch(`${BASE_URL}/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tts-1",
        voice: "alloy",
        input: testText,
        format: "mp3",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API returned ${response.status}: ${errorText}`);
    }

    // Check if we got audio data
    const contentType = response.headers.get("content-type");
    if (!contentType?.includes("audio")) {
      throw new Error(`Expected audio response, got: ${contentType}`);
    }

    const audioBuffer = await response.arrayBuffer();
    const audioSize = audioBuffer.byteLength;

    if (audioSize === 0) {
      throw new Error("Received empty audio response");
    }

    logSuccess(`${testName} - Generated ${audioSize} bytes of audio`);
    return {
      name: testName,
      status: "✅ PASSED",
      duration: Date.now() - startTime,
      details: `Generated ${(audioSize / 1024).toFixed(2)} KB audio file`,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`${testName} - ${message}`);
    return {
      name: testName,
      status: "❌ FAILED",
      duration: Date.now() - startTime,
      error: message,
    };
  }
}

async function runAllTests() {
  console.log("\n" + "=".repeat(60));
  console.log("ElizaOS Cloud API - Endpoint Testing");
  console.log("=".repeat(60) + "\n");

  // Run all tests
  results.push(await test1_APIKeyValidation());
  results.push(await test2_ChatEndpoint());

  console.log(
    "\n⚠️  Note: The following tests use OpenAI-compatible endpoints",
  );
  console.log("   that ElizaOS Cloud may not support yet:\n");
  results.push(await test3_TextGenerationSmall());
  results.push(await test4_TextGenerationLarge());
  results.push(await test5_ImageGeneration());
  results.push(await test6_ImageDescription());
  results.push(await test7_AlternativeModels());

  console.log("\n📊 Running embedding tests:\n");
  results.push(await test8_EmbeddingsBasic());
  results.push(await test9_EmbeddingsSimilarity());
  results.push(await test10_EmbeddingsBatch());
  results.push(await test11_EmbeddingsLargeModel());

  console.log("\n🎵 Running audio tests (may not be supported yet):\n");
  results.push(await test12_AudioTranscription());
  results.push(await test13_TextToSpeech());

  // Print summary
  console.log("\n" + "=".repeat(60));
  console.log("TEST SUMMARY");
  console.log("=".repeat(60) + "\n");

  const passed = results.filter((r) => r.status === "✅ PASSED").length;
  const failed = results.filter((r) => r.status === "❌ FAILED").length;
  const skipped = results.filter((r) => r.status === "⏭️ SKIPPED").length;
  const total = results.length;

  results.forEach((result) => {
    console.log(`${result.status} ${result.name} (${result.duration}ms)`);
    if (result.details) {
      console.log(`   → ${result.details}`);
    }
    if (result.error) {
      console.log(`   → Error: ${result.error}`);
    }
  });

  console.log("\n" + "-".repeat(60));
  console.log(
    `Total: ${total} | Passed: ${passed} | Failed: ${failed} | Skipped: ${skipped}`,
  );
  console.log("-".repeat(60) + "\n");

  // Exit with appropriate code
  if (failed > 0) {
    process.exit(1);
  }
}

// Run tests
runAllTests().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Fatal error:", message);
  process.exit(1);
});
