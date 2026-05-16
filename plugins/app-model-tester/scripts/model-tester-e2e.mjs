#!/usr/bin/env node

const baseUrl = process.env.MODEL_TESTER_BASE_URL ?? "http://127.0.0.1:31337";
const requireAll = process.env.MODEL_TESTER_REQUIRE_ALL === "1";

const requiredPass = new Set(["text-small", "text-large", "embedding", "vad"]);
const tests = [
  "text-small",
  "text-large",
  "embedding",
  "text-to-speech",
  "transcription",
  "vad",
  "image-description",
  "image",
];

const knownUnavailable = [
  "no TTS backend available",
  "Cannot transcribe audio: no voice session active",
  "No handler found for delegate type: TRANSCRIPTION",
  "vision describe requires an mmproj-loaded server",
  "imagegen-sd-1_5-q5_0 is not installed",
  "OpenAI TTS failed: 404",
  "OpenAI transcription failed: 404",
  "OpenAI image generation failed: 404",
  "OpenAI image description failed: 404",
  "credit balance is too low",
];

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function skip(message) {
  console.log(`[model-tester-e2e] SKIP ${message}`);
}

async function fetchJson(path, init) {
  const response = await fetch(new URL(path, baseUrl), init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

async function main() {
  let htmlResponse;
  try {
    htmlResponse = await fetch(new URL("/model-tester", baseUrl), {
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    if (!requireAll) {
      skip(
        `model tester server is unavailable at ${baseUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    throw error;
  }
  const html = await htmlResponse.text();
  if (!htmlResponse.ok) {
    throw new Error(`/model-tester returned ${htmlResponse.status}`);
  }
  if (!html.includes("Model Tester")) {
    fail("/model-tester did not render the static tester shell");
  }
  if (html.includes("@vite/client") || html.includes("react-refresh")) {
    fail("/model-tester includes Vite/HMR code; this can reintroduce flicker");
  }

  const status = await fetchJson("/api/model-tester/status");
  const ids = new Set((status.tests ?? []).map((test) => test.id));
  for (const test of tests) {
    if (!ids.has(test)) fail(`status endpoint is missing ${test}`);
  }

  const results = [];
  for (const test of tests) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 240_000);
    try {
      const result = await fetchJson("/api/model-tester/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          test,
          prompt: "Say exactly one short sentence proving the Eliza model tester works.",
        }),
        signal: controller.signal,
      });
      results.push(result);
    } finally {
      clearTimeout(timeout);
    }
  }

  for (const result of results) {
    const label = `${result.test}: ${result.ok ? "PASS" : "FAIL"}`;
    console.log(label);
    if (result.ok) continue;

    const error = String(result.error ?? "");
    const unavailable = knownUnavailable.some((needle) => error.includes(needle));
    if (requireAll || requiredPass.has(result.test) || !unavailable) {
      fail(`${result.test} failed unexpectedly:\n${error}`);
    } else {
      console.log(`  unavailable backend: ${error.split("\n")[0]}`);
    }
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.stack || error.message : String(error));
});
