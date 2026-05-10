# Prompt cache validation

Use `scripts/cache-hit-rate-harness.mjs` to inspect sanitized request shape, stable prefix hashes, provider options, latency, and normalized cache usage across repeated calls.

Dry run is the default and is safe for CI:

```bash
node scripts/cache-hit-rate-harness.mjs --provider=elizacloud
```

Live runs require an explicit guard plus the provider API key:

```bash
MILADY_CACHE_LIVE=1 \
ELIZAOS_CLOUD_API_KEY=... \
node scripts/cache-hit-rate-harness.mjs --provider=elizacloud --calls=3
```

The Eliza Cloud large planner default is OpenRouter DeepSeek V4 Pro with model ID `deepseek/deepseek-v4-pro` (released Apr 24, 2026 on OpenRouter). The small/response-handler default remains `openai/gpt-oss-120b:nitro` unless service routing or config overrides it.

Supported harness providers:

- `elizacloud`: OpenAI-compatible Eliza Cloud `/chat/completions`; default model `deepseek/deepseek-v4-pro`.
- `openrouter`: direct OpenRouter `/chat/completions`; default model `deepseek/deepseek-v4-pro`.
- `openai`: direct OpenAI `/chat/completions`; default model `gpt-5.4-mini`.
- `anthropic`: direct Anthropic `/v1/messages`; default model `claude-opus-4.7`.

Useful knobs:

- `--model=<id>` overrides the default model.
- `--calls=<n>` controls repeated calls; use at least `3` for cold/warm comparison.
- `MILADY_CACHE_PROMPT_KEY=<key>` sets the stable prompt cache key included in OpenAI-compatible payloads.

Expected validation loop:

1. Run dry mode and inspect `request.messageShape`, `tools`, `providerOptionsKeys`, and `prefixHash`.
2. Run live mode once per provider.
3. Confirm call 1 has low or zero `cachedInputTokens`.
4. Confirm calls 2+ report increasing `cachedInputTokens` or `cacheReadInputTokens` while `prefixHash` stays unchanged.
5. If hit rate is low, compare sanitized request shapes and provider options between calls before changing prompt layout.
