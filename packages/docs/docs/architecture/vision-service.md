# Vision Service Architecture (VS-1)

> Status: design accepted, implementation in progress on `develop`.

## Motivation

Vision must NOT require an Anthropic API key. Today, image-understanding work in elizaOS
is implicitly tied to whichever text provider the user happens to have configured (and in
practice that has meant Anthropic). That violates the product rule that any first-class
capability should be selectable per-provider with a cheap default available through Eliza
Cloud or the user's existing inference subscription.

## Goals

- A first-class **vision model slot** registered through the same `useModel` /
  `registerModel` plumbing every other model already uses.
- A provider-neutral API: caller passes `{ image, prompt }`, receives `{ text }`.
- Cheap defaults wired up for every text provider that ships vision (OpenAI, Anthropic,
  Groq, Eliza Cloud) so users never need to add a new API key purely to enable vision.
- A vision row in the provider switcher UI with sensible auto-selection.

## Model slot

Added to `packages/core/src/types/model.ts`:

```ts
ModelType.VISION_LANGUAGE = "VISION_LANGUAGE"
```

Handler signature:

```ts
(runtime, {
  image: { base64?: string; mediaType: string; url?: string };
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
}) => Promise<{ text: string; raw?: unknown }>
```

Either `image.base64` or `image.url` must be set. `mediaType` (e.g. `image/png`) is
required so providers that need it for inline data can format the payload correctly.

## Provider adapters

| Provider     | Default model                                        | Notes                            |
| ------------ | ---------------------------------------------------- | -------------------------------- |
| Groq         | `meta-llama/llama-4-scout-17b-16e-instruct`          | Cheapest; default when available |
| OpenAI       | `gpt-5.5-mini`                                       | Tracks `OPENAI_SMALL_MODEL`      |
| Anthropic    | `claude-haiku-4-5-20251001` -> Sonnet on retry       | Falls back if Haiku rate-limits  |
| Eliza Cloud  | routed via `packages/cloud-routing`                  | Uses configured cloud key        |

Each adapter calls `registerModel(ModelType.VISION_LANGUAGE, handler)` from the plugin's
existing init() so vision turns on automatically whenever the text plugin has credentials.

## Runtime endpoint

`POST /api/runtime/vision` (in `packages/app-core/src/api/`) delegates to
`runtime.useModel(ModelType.VISION_LANGUAGE, body)` and returns the handler result. This is
the surface the AI-QA harness and any client-side debug tooling use; it deliberately does
not duplicate logic.

## UI

`packages/ui/src/components/settings/ProviderSwitcher.tsx` gains a Vision row whose
default selection order is:

1. Eliza Cloud (if linked).
2. The text provider already selected (when it ships vision).
3. Groq (if a key is configured).
4. "Not configured" sentinel.

`packages/ui/src/onboarding-config.ts` learns a `vision` routing slot so the onboarding
config writer persists the user's selection.

## AI-QA hook

`scripts/ai-qa/analyze.mjs` gains an `AI_QA_USE_RUNTIME=1` mode that routes screenshot
analysis through the runtime endpoint above instead of hard-coding an Anthropic call. The
existing direct-Anthropic path remains for offline reproducibility.

## Out of scope (VS-2)

Local-inference vision (LLaVA / Llama-Vision via `plugin-local-inference`) is tracked
under VS-2. This document covers the cloud-provider story only.
