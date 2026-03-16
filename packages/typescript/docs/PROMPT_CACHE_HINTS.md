# Prompt cache hints

This document explains **why** prompt cache hints exist, how they work, and common pitfalls for implementers and operators.

## Why this exists

Repeated LLM calls (e.g. message handling, batched evaluators, autonomy) often send the same instructions and output format while only the **context** (state, memories, validation codes) changes. Provider-side prompt caching lets the API reuse tokens for the stable prefix:

- **Anthropic:** Block-level ephemeral cache; you mark which content blocks are cacheable.
- **OpenAI:** Automatic prefix caching when the prompt is ≥1024 tokens; stable content must be at the start.
- **Gemini:** Prefix-based context caching; stable content first improves hit rate.

Without hints, the provider sees one flat prompt and may not cache effectively. The core describes which parts are stable so each provider can map that to its own API without the core needing to know provider-specific parameters.

## Contract

- **Types:** `PromptSegment = { content: string; stable: boolean }`. `GenerateTextParams` has optional `promptSegments?: PromptSegment[]`.
- **Invariant:** When `promptSegments` is set, `prompt` MUST equal `promptSegments.map(s => s.content).join("")`.
  - **Why:** Providers that ignore segments still get correct behavior by using `prompt`. Providers that use segments must send the same total text so model behavior is unchanged.
- **Stable** = content is identical across calls for the same schema/character (instructions, format, example). **Unstable** = changes every call (state, validation UUIDs).

## How the runtime builds segments

In `dynamicPromptExecFromState`, the prompt is split into:

1. **Variable block** (unstable) — initial/middle codes, `output`, smart retry context.
2. **Format stable prefix** (stable) — “Do NOT include thinking…”, “Go directly to format…”
3. **Format middle block** (unstable) — `VALIDATION_INSTRUCTIONS` (per-call UUIDs and checkpoint codes) or `"\n\n"` when validation is disabled.
4. **Format stable suffix** (stable) — “Respond using … format like this”, example, “IMPORTANT: …”
5. **End block** (unstable) — end code.

**Why split validation out:** `VALIDATION_INSTRUCTIONS` contains per-call UUIDs. If we marked it stable, provider caches would never hit because that content changes every request. Only the format instructions and example (same for same schema) are marked stable.

## Provider behavior

- **Anthropic:** When `promptSegments` is present, the plugin sends a Messages payload with one content block per segment. Blocks with `stable === true` get `cache_control: { type: "ephemeral" }`. **Why:** Anthropic caches at the block level when so marked.
- **OpenAI / Gemini:** When `promptSegments` is present, the plugin builds a single prompt string with **stable segments first**, then unstable (stable sort preserves order within each group). **Why:** Both use prefix-based caching; putting stable content first maximizes the cacheable prefix. No new API fields—ordering is the hint.

## Pitfalls for operators

- **OpenAI:** Caching only applies when the prompt is ≥1024 tokens. Very short prompts will not show cache savings.
- **Small / low-param models:** Some models may not support or benefit from caching; behavior is unchanged, but don’t expect cache metrics everywhere.
- **Correctness:** Caching is a performance/cost optimization; correctness does not depend on it. If a provider ignores segments, the prompt is still correct.

## Pitfalls for implementers

- **Do not mutate segment objects.** Always create new `{ content, stable }` objects. **Why:** Params may be passed to multiple handlers or stored; mutation can cause cross-request bugs.
- **Segment order must match prompt order.** Build segments in the exact order the prompt string is built. **Why:** Wrong order breaks the invariant and can send the wrong prompt to the model.
- **Only mark content stable when it is truly stable.** Content that includes per-call UUIDs or changing state will never cache; mislabeling it as stable wastes cache capacity. **Why:** Provider caches key on content; changing content means no hit.
- **When using segments in the API,** ensure the final text seen by the model equals the intended full prompt (e.g. `params.prompt` or the stable-first concatenation). **Why:** Reordering for prefix cache is intentional; dropping or duplicating text is not.
- **“Stable first” ordering:** Concatenate stable segments in their **original** order, then unstable in order. Do not sort arbitrarily. **Why:** JavaScript’s stable sort preserves relative order within groups; we rely on that so the model still sees a coherent prompt.

## Rollback

- **Core:** Remove `promptSegments` from modelParams and the type; revert runtime segment building. No plugin changes required.
- **Plugins:** In each plugin, remove the `promptSegments` branch and always use `params.prompt`. Core can keep emitting segments for a future retry.
- No data or config migration; the feature is additive.
