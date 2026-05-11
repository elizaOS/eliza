# Eliza-1 precache strategy (text-side KV)

> **Scope:** the local-inference text path (`packages/app-core/src/services/
> local-inference/`). This is the I1–I5 / C1 mechanism slice of the
> Eliza-1 voice swarm — what gets KV-prefilled before the user's tokens
> land, when, how it's keyed, and how it's invalidated. The drafter
> co-residency and first-audio filler are cross-referenced (W13 owns the
> audio side); only the text-KV pieces are owned here.

The goal is to make "user stops speaking → agent's first token" as close
to "decode the user's tokens + sample" as possible — the system prompt,
tool/action schema block, and stable provider blocks should already be in
the slot's KV by the time STT finishes.

---

## What is precached

### 1. The Stage-1 response-handler stable prefix (`renderMessageHandlerStablePrefix`)
The bulk of every turn's prompt is the part that does *not* depend on the
user's message: the canonical system prompt, the `HANDLE_RESPONSE` tool
schema block, the available-contexts catalog, and the stable provider
blocks (character, capabilities, etc.). `@elizaos/core` exposes
`renderMessageHandlerStablePrefix(runtime, roomId)` which renders exactly
the stable segments of the Stage-1 model input — byte-identical to the
`messages[0].content` (the "system" message) that
`renderMessageHandlerModelInput` would produce for the first turn of a
fresh conversation in that room, with the unstable tail (recent dialogue,
the current user message) dropped.

This string is what the local engine pre-warms with: a `max_tokens: 1`,
`temperature: 0`, `cache_prompt: true` chat completion against the
deterministic slot the conversation pins to (`DflashLlamaServer.
prewarmConversation` → `localInferenceEngine.prewarmConversation` →
`prewarmResponseHandler` in `ensure-local-inference-handler.ts`). When the
real Stage-1 request lands it appends the user turn to the same prefix, so
llama-server only forward-passes the new tokens; `--slot-prompt-similarity
0.7` covers any minor trailing-instruction drift.

### 2. The system prefix on slot 0 at model load (`conv:__system_prefix__`)
At runtime boot, once a local model is resident, `prewarmSystemPrefix`
fires the same stable prefix against the synthetic conversation id
`__system_prefix__`. `deriveSlotId("conv:__system_prefix__", parallel)` is
stable, so this always warms the same slot before any user message — and
because llama-server's radix KV is shared across slots, every per-room
conversation that opens later inherits the common prefix tokens.

### 3. Drafter co-residency (cross-ref W4 / `packages/inference/AGENTS.md` §3)
The DFlash drafter is mmapped alongside the target by `llama-server`
itself (`-md <drafter> --spec-type dflash …`) — there is no separate
"load drafter" step, so it is "precached" by construction the moment the
server starts. Owned by W4 (`dflash-server.ts` startup + the
`DflashDrafterHandle` in `voice/shared-resources.ts`).

### 4. First-audio filler (cross-ref W13 / W9)
Pre-generating a short acknowledgement audio chunk ("one sec", "got it",
…) on VAD fire is the audio-side counterpart to the text-KV pre-warm.
Owned by W13's phrase cache (`voice/phrase-cache.ts`,
`cache/voice-preset-default.bin`) and W9's turn controller; not part of
this module.

---

## When precache fires

| Trigger                              | What's warmed                                  | Call site |
| ------------------------------------ | ---------------------------------------------- | --------- |
| **Model load / runtime boot**        | system prefix on `conv:__system_prefix__`      | `ensureLocalInferenceHandler` → `prewarmSystemPrefix` (fire-and-forget) |
| **Voice session open / `speech-start`** | Stage-1 stable prefix on `conv:<roomId>`     | W9 turn controller → `prewarmResponseHandler(runtime, roomId)` |
| **Keep-alive sweep** (~4 min, < short TTL) | re-issues the last pre-warm prefix for slots untouched ≥ 80% of the short TTL | `DflashLlamaServer` keep-alive timer (`startKeepAliveTimer`) |
| **First real Stage-1 request**       | (no extra work) appends the user turn to the warm prefix | `runV5MessageRuntimeStage1` → `useModel(RESPONSE_HANDLER)` with `conversationId: roomId` |

`prewarmConversation` is best-effort by definition: a failure (server not
running, render throws, HTTP error) just means the real request
cold-prefills — the pre-pre-warm behaviour. It must never paper over a
*broken* cache key with retries; it only saves the prefill cost when the
key is sound.

It is a no-op on the in-process `node-llama-cpp` backend — that backend's
session pool already pins by cache key, so there is nothing to pre-warm.

---

## How it's keyed

KV reuse cache-key precedence (`cache-bridge.ts resolveLocalCacheKey`):

1. `conv:<conversationId>` — strongest. The Stage-1 call site passes
   `conversationId: String(roomId)` through `buildProviderCachePlan`
   (`@elizaos/core/src/runtime/provider-cache-plan.ts` →
   `providerOptions.eliza.conversationId`), so **every turn of a room — and
   the pre-warm for it — lands on the same KV slot**. This is the dominant
   reuse signal for chat and voice.
2. `seg:<hashStablePrefix(promptSegments)>` — hash of the longest run of
   `stable: true` segments, derived from
   `providerOptions.eliza.promptSegments`.
3. `pfx:<prefixHash>` — `providerOptions.eliza.prefixHash` (already
   stable-only via `cachePrefixSegments` upstream).
4. `v5:<prefixHash>` — `promptCacheKey` back-compat fallback.

`deriveSlotId(cacheKey, parallel)` maps the key into `[0, parallel)`. The
`conversationRegistry` additionally pins each open conversation to the
lowest-loaded slot via `pickLowestLoadedSlot` so two distinct
conversations whose keys hash-collide don't thrash each other.

The synthetic `conv:__system_prefix__` key is intentionally not a real
`roomId` — it carries no per-room state, only the model-and-config-stable
prefix, so a fixed id is correct.

**Verified:** `buildProviderCachePlan` does emit `conversationId` /
`promptSegments` / `prefixHash` on the voice + response-handler path —
`runV5MessageRuntimeStage1` (`packages/core/src/services/message.ts`)
passes all three, with `conversationId = String(message.roomId)`. Voice
messages travel the `VOICE_DM` channel with a populated `roomId`, so the
local cache key is `conv:<roomId>` per conversation with no degradation.
No runtime fix was required for key stability — the pre-warm path just has
to reuse the same `roomId`, which `prewarmResponseHandler` does.

---

## How it's invalidated

There is no explicit invalidation step — KV reuse is structural, not
event-driven:

- **Prompt drift within a turn.** The unstable tail (recent dialogue, the
  current message, timestamps) is *not* part of the cache key, so it never
  shifts the slot; llama-server forward-passes whatever doesn't match the
  cached prefix. `--slot-prompt-similarity 0.7` lets a slightly different
  trailing instruction block still reuse the common prefix.
- **System-prompt / tool-schema change.** A real change to the character
  system prompt, the registered actions/contexts, or the
  `messageHandlerTemplate` changes the rendered stable prefix → the next
  pre-warm and the next real request simply forward-pass the new tokens
  onto whatever the slot held. The optimizer artifacts
  (`OptimizedPromptService`) deliberately keep the rendered prompt text
  stable to avoid churning this prefix.
- **Model swap.** `buildModelHash` keys the on-disk slot directory by
  `sha256(target + drafter + cache-types + ctx + parallel)[:16]`, so
  switching the active model uses a different directory and the old slot
  files are orphaned (and aged out by the eviction sweep, below).
- **Idle conversation.** `conversationRegistry.evictIdle()` (run on the
  eviction timer) drops handles untouched past their TTL (default 60 min),
  persisting each one's KV to `<slotDir>/<convId>.long.bin` and closing
  it — so an idle handle is flushed-and-dropped rather than lingering and
  inflating the parallel high-water mark. A re-open lazy-restores from the
  `.bin`.
- **On-disk slot/conversation `.bin` eviction.** `evictExpired` deletes
  slot/conversation `.bin` files older than their *per-file* TTL horizon.
  The TTL class is encoded in the filename as `<base>.<ttl>.bin`
  (`slotCacheFileName` / `parseSlotCacheTtlClass`); files written without
  an encoded class keep the `long` horizon (the prior global behaviour).
  Conversation KV persisted on close/checkpoint/shutdown is written
  `.long.bin`. The sweep runs every `ELIZA_LOCAL_EVICTION_INTERVAL_MS`
  (default 5 min) alongside the `evictIdle` pass.

---

## Tunables

| Env var                             | Default | Effect |
| ----------------------------------- | ------- | ------ |
| `ELIZA_LOCAL_EVICTION_INTERVAL_MS`  | 300000  | eviction + `evictIdle` sweep interval (clamped ≥ 60 s) |
| `ELIZA_LOCAL_KEEPALIVE_INTERVAL_MS` | 240000  | keep-alive re-warm sweep interval (clamped ≥ 30 s) |
| `ELIZA_DFLASH_HOST` / port          | loopback | the `llama-server` the pre-warm requests hit |

The short / long / extended cache-TTL windows (`DEFAULT_CACHE_TTLS` —
5 min / 60 min / 24 h) mirror the cloud ephemeral-cache semantics and are
what `ttlMsForKey` resolves a per-file class to. The keep-alive sweep
re-warms a slot once it has been untouched for 80% of the short TTL
(`KEEPALIVE_STALE_FRACTION`).
