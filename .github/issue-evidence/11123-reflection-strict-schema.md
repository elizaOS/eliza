# Evidence — #11123 reflection extraction fails on strict structured-output providers

Setup: real eliza-code in-process agent (sql + plugin-openai + coding-tools +
shell) pointed at the REAL Eliza Cloud (`gpt-oss-120b`, cerebras-served)
through a local logging proxy (`:8899 → api.elizacloud.ai`) so every request
body and response is captured verbatim. Nothing mocked.

## 1. The bug, observed live (pre-fix)

Every turn: the main reply succeeds, then the post-turn reflection call dies —

```
[03:03:01] POST /v1/chat/completions {"model":"gpt-oss-120b","stream":true,…,"hasTools":1}                  → 200 in 7175ms
[03:03:03] POST /v1/chat/completions {"model":"gpt-oss-120b","stream":true,"response_format":"json_schema"} → 200 in 1427ms ⚠ERROR
    ↳ {"error":{"message":"Bad Request","type":"rate_limit_error","code":500}}
```

The captured request body is core's combined reflection schema
(factMemory/relationships/identities ops). Fact/relationship/identity
memories are never written.

## 2. Root cause isolated by live bisection (same endpoint, same model)

| response_format.json_schema variant | result |
|---|---|
| object `{properties:{}, additionalProperties:false, required:[]}` | ✅ 200, valid JSON returned |
| object `{additionalProperties:false}` — **no `properties`** | ❌ `Bad Request` |
| object `{additionalProperties:true}` | ❌ `Bad Request` |
| array `{items:…, maxItems:16}` | ❌ `Bad Request` |
| `enum` / missing top-level `name` | ✅ fine |

The reflection schema hits BOTH failing shapes: `structured_fields` /
`metadata` are object nodes without `properties`, and `keywords` carries
`maxItems: 16`.

## 3. The fix, verified live (post-fix, same proxy, same prompt class)

```
[03:41:59] POST /v1/chat/completions {…,"hasTools":1}                              → 200 in 8617ms
[03:42:04] POST /v1/chat/completions {…,"response_format":"json_schema"}           → 200 in 4967ms      (no error chunk)
```

The extraction stream completes cleanly — 4.9s of real generation instead of
a fast reject.

## 4. Mutation checks — the new invariant test catches both shapes

Test: walks every reflection evaluator's response schema; every object node
must declare `properties` + `additionalProperties:false`, and no node may use
strict-unsupported constraint keywords (`maxItems`, `minItems`, `maxLength`,
`pattern`, `minimum`, …).

- Revert `structured_fields` to the bare object → `Tests 1 failed | 2 passed`.
- Re-add `maxItems: 16` to keywords → `Tests 1 failed | 2 passed`.
- Fixed code → `Tests 3 passed (3)`.

## 5. Behavior preserved

- `properties: {}` on the open-ended objects changes nothing semantically —
  the code already documented "no extra keys land in structured_fields".
- The 16-keyword cap moves from the wire schema into code: zod now **trims**
  to 16 (previously `.max(16)` would fail the whole op on the 17th keyword),
  and storage re-caps via `MAX_KEYWORDS` (`fact-keywords.ts:66,127`) as
  before.
- Full evaluator suite green; `tsgo --noEmit` clean; full multi-target core
  build (`node + browser + edge`) green; biome clean.

## N/A rows

- Screenshots / video: N/A — headless runtime/schema change, no UI surface.
- Frontend logs: N/A — no client involved; the wire captures above are the
  network evidence.
- Live-LLM trajectory file: the proxy captures in §1/§3 ARE the live model
  interaction (request body + streamed response) for the exact code path
  changed; the reflection call's output is consumed internally by the
  evaluator (no user-visible reply to record).
