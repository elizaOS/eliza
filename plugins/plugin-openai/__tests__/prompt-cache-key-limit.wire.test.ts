/**
 * Regression for the 64-character `prompt_cache_key` limit OpenAI-compatible
 * upstreams enforce (OpenRouter's Azure upstream rejected the canonical
 * `v5:` + 64-char-hash key with HTTP 400 and blocked a model reply). Drives the
 * real AI SDK serialization through `handleTextSmall` against a deterministic
 * transport that rejects any longer key. No request leaves the test; live
 * provider quality is a separate gate.
 */
import { createHash } from "node:crypto";
import { AgentRuntime, type GenerateTextParams, InMemoryDatabaseAdapter } from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import { buildProviderCachePlan } from "../../../packages/core/src/runtime/provider-cache-plan";
import { handleTextSmall } from "../models/text";

afterEach(() => vi.restoreAllMocks());

const MAX_WIRE_KEY_LENGTH = 64;
const REJECTING_HOST = "prompt-cache-key-fixture.invalid";

function prefixHash(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

async function sendThroughRejectingTransport(prefixHashValue: string) {
  const runtime = new AgentRuntime({
    character: { name: "Prompt cache key fixture", bio: "test", settings: {} },
    adapter: new InMemoryDatabaseAdapter(),
    logLevel: "fatal",
    settings: {
      ELIZA_PROVIDER: "openai",
      OPENAI_BASE_URL: `https://${REJECTING_HOST}/v1`,
      OPENAI_API_KEY: "prompt-cache-key-fixture-key",
      CEREBRAS_API_KEY: "",
      OPENROUTER_API_KEY: "",
      OPENROUTER_FALLBACK_MODEL: "",
    },
  });
  const plan = buildProviderCachePlan({ prefixHash: prefixHashValue });
  const bodies: Record<string, unknown>[] = [];
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url
    );
    expect(url.hostname).toBe(REJECTING_HOST);
    expect(url.pathname).toBe("/v1/chat/completions");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const key = body.prompt_cache_key;
    if (typeof key === "string" && key.length > MAX_WIRE_KEY_LENGTH) {
      // Mirrors OpenRouter's Azure upstream rejection that broke onboarding.
      return Response.json(
        {
          error: {
            message: `prompt_cache_key: maximum ${MAX_WIRE_KEY_LENGTH} characters, received ${key.length}`,
          },
        },
        { status: 400 }
      );
    }
    return Response.json({
      id: "prompt-cache-key-fixture",
      object: "chat.completion",
      created: 0,
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
    });
  });
  try {
    await handleTextSmall(runtime, {
      prompt: "Preserve this entire request: café 🧭 END.",
      system: "Reply briefly. Do not perform actions.",
      providerOptions: plan.providerOptions,
    } as GenerateTextParams);
    expect(bodies).toHaveLength(1);
    return { body: bodies[0], plan };
  } finally {
    fetch.mockRestore();
  }
}

it("sends a within-limit prompt_cache_key through the real SDK request and preserves messages", async () => {
  const { body, plan } = await sendThroughRejectingTransport(
    prefixHash("canonical-stage-1-prefix")
  );
  const expectedKey = (plan.providerOptions.openai as { promptCacheKey: string }).promptCacheKey;
  expect(body.prompt_cache_key).toBe(expectedKey);
  expect(expectedKey).toHaveLength(MAX_WIRE_KEY_LENGTH);
  // The SDK may map `system` to `developer` for this model family; the point is
  // that every message survives unchanged.
  const messages = body.messages as Array<{ role: string; content: string }>;
  expect(messages).toHaveLength(2);
  expect(messages[0]).toMatchObject({ content: "Reply briefly. Do not perform actions." });
  expect(messages[0].role).toMatch(/^(system|developer)$/);
  expect(messages[1]).toEqual({
    role: "user",
    content: "Preserve this entire request: café 🧭 END.",
  });
});

it("is stable for one prefix hash and distinct for hashes differing only at the end", async () => {
  const sharedPrefix = "b".repeat(63);
  const first = await sendThroughRejectingTransport(prefixHash(`${sharedPrefix}0`));
  const repeat = await sendThroughRejectingTransport(prefixHash(`${sharedPrefix}0`));
  const other = await sendThroughRejectingTransport(prefixHash(`${sharedPrefix}1`));
  expect(first.body.prompt_cache_key).toBe(repeat.body.prompt_cache_key);
  expect(other.body.prompt_cache_key).not.toBe(first.body.prompt_cache_key);
});
