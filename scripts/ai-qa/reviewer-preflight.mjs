#!/usr/bin/env node

/**
 * Bounded Anthropic reviewer-provider preflight.
 *
 * The walkthrough calls this before starting the expensive browser journey.
 * It sends one tiny text-only request and classifies credential and billing
 * failures without attempting any screenshot reviews.
 */

import { pathToFileURL } from "node:url";

const DEFAULT_ENDPOINT = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_VERSION = "2023-06-01";

export function classifyReviewerFailure(status, responseBody = "") {
  const body = String(responseBody).toLowerCase();

  if (status === 401 || status === 403) return "rejected-credentials";
  if (
    body.includes("credit balance is too low") ||
    body.includes("insufficient credit") ||
    body.includes("insufficient_credit")
  )
    return "insufficient-credit";
  if (
    status === 429 ||
    body.includes("quota") ||
    body.includes("rate limit") ||
    body.includes("rate_limit")
  )
    return "quota-exhausted";
  return "provider-error";
}

export async function preflightReviewer({
  apiKey = process.env.ANTHROPIC_API_KEY,
  endpoint = DEFAULT_ENDPOINT,
  model = process.env.AI_QA_VISION_MODEL || DEFAULT_MODEL,
  timeoutMs = 15_000,
  fetchImpl = fetch,
} = {}) {
  if (!apiKey?.trim()) {
    return {
      ok: false,
      classification: "missing-credentials",
      detail: "ANTHROPIC_API_KEY is not configured",
    };
  }

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [
          {
            role: "user",
            content: "Reply with one character to validate reviewer access.",
          },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return {
      ok: false,
      classification:
        error?.name === "TimeoutError" || error?.name === "AbortError"
          ? "provider-timeout"
          : "provider-unreachable",
      detail: error?.message || String(error),
    };
  }

  if (response.ok) return { ok: true, classification: "ready", detail: "" };

  const body = (await response.text()).slice(0, 500);
  return {
    ok: false,
    classification: classifyReviewerFailure(response.status, body),
    detail: `HTTP ${response.status}: ${body}`,
  };
}

async function main() {
  const result = await preflightReviewer();
  if (result.ok) {
    console.log("[walkthrough-vision] reviewer preflight: ready");
    return;
  }

  console.error(
    `[walkthrough-vision] reviewer preflight failed (${result.classification}): ${result.detail}`,
  );
  process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
