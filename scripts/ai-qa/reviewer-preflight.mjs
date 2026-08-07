#!/usr/bin/env node

/**
 * Bounded reviewer-provider preflight for Anthropic or OpenAI.
 *
 * The walkthrough calls this before starting the expensive browser journey.
 * It sends one tiny text-only request and classifies credential and billing
 * failures without attempting any screenshot reviews.
 */

import { pathToFileURL } from "node:url";

const DEFAULT_ENDPOINT = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_OPENAI_MODEL = "gpt-5-mini";
const ANTHROPIC_VERSION = "2023-06-01";

export function resolveReviewerBackend(env = process.env) {
  const explicit = env.AI_QA_VISION_BACKEND?.trim().toLowerCase();
  if (explicit === "anthropic" || explicit === "openai") return explicit;
  if (explicit) return null;
  if (env.ANTHROPIC_API_KEY?.trim()) return "anthropic";
  if (env.OPENAI_API_KEY?.trim()) return "openai";
  return null;
}

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
  backend = "anthropic",
  apiKey,
  endpoint,
  model,
  timeoutMs = 15_000,
  fetchImpl = fetch,
} = {}) {
  const isOpenAi = backend === "openai";
  const resolvedApiKey =
    apiKey ??
    (isOpenAi ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY);
  const resolvedEndpoint =
    endpoint ?? (isOpenAi ? DEFAULT_OPENAI_ENDPOINT : DEFAULT_ENDPOINT);
  const resolvedModel =
    model ??
    process.env.AI_QA_VISION_MODEL ??
    (isOpenAi ? DEFAULT_OPENAI_MODEL : DEFAULT_MODEL);
  if (!resolvedApiKey?.trim()) {
    return {
      ok: false,
      classification: "missing-credentials",
      detail: `${isOpenAi ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"} is not configured`,
    };
  }

  let response;
  try {
    response = await fetchImpl(resolvedEndpoint, {
      method: "POST",
      headers: isOpenAi
        ? {
            "content-type": "application/json",
            authorization: `Bearer ${resolvedApiKey}`,
          }
        : {
            "content-type": "application/json",
            "x-api-key": resolvedApiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          },
      body: JSON.stringify(
        isOpenAi
          ? {
              model: resolvedModel,
              max_tokens: 1,
              messages: [
                {
                  role: "user",
                  content:
                    "Reply with one character to validate reviewer access.",
                },
              ],
            }
          : {
              model: resolvedModel,
              max_tokens: 1,
              messages: [
                {
                  role: "user",
                  content:
                    "Reply with one character to validate reviewer access.",
                },
              ],
            },
      ),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // error-policy:J1 transport boundary — translate fetch-layer failures
    // (timeout/abort, DNS, connection refusal) into a typed preflight failure
    // so the walkthrough halts before browser/model work instead of crashing.
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
  const backend = resolveReviewerBackend();
  if (backend === null) {
    console.error(
      "[walkthrough-vision] reviewer preflight failed (missing-credentials): configure AI_QA_VISION_BACKEND with its provider key",
    );
    process.exitCode = 2;
    return;
  }
  const result = await preflightReviewer({ backend });
  if (result.ok) {
    console.log(`[walkthrough-vision] reviewer preflight: ${backend} ready`);
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
