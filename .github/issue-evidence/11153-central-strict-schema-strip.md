# Evidence — #11153 centralize strict-provider constraint stripping

Follow-up to #11123 (which fixed one schema). This centralizes the fix at the
single wire choke point so the whole bug class dies.

## 1. The choke point (verified by reading the code)

`sanitizeJsonSchema` (plugins/plugin-openai/models/text.ts) is called by BOTH
send paths:
- response_format: `buildStructuredOutput` → `jsonSchema(sanitizeJsonSchema(schema, true))` (text.ts:399)
- tools: `normalizeNativeTools` → `sanitizeJsonSchema(rawSchema, true)` (text.ts:439)

Pre-fix it did `let sanitized = { ...record }` — spreading every key through, so
constraint keywords reached the wire untouched.

## 2. The exact rejected set — bisected LIVE (api.elizacloud.ai / gpt-oss-120b, response_format json_schema)

```
array.maxItems    → REJECTED       num.minimum     → ok
array.minItems    → REJECTED       num.maximum     → ok
str.maxLength     → REJECTED       num.multipleOf  → ok
str.minLength     → REJECTED       array.uniqueItems → ok
str.pattern       → REJECTED
str.format        → REJECTED
obj.minProperties → REJECTED
obj.maxProperties → REJECTED  (symmetric with minProperties)
```

Correction to prior lore: numeric bounds (`minimum`/`maximum`/`multipleOf`) and
`uniqueItems` are ACCEPTED — so `search-experiences`'s `minimum/maximum`
(flagged suspect in the sweep) is a non-issue and is left untouched.

## 3. The fix

`stripStrictUnsupportedConstraints(node)` removes the rejected set and folds a
human phrase into `description` (`maxItems: 3` → "(at most 3 items)"), so the
model keeps the guidance. Called unconditionally at the top of
`sanitizeJsonSchema` (recursion reaches nested nodes via properties/items/
anyOf/oneOf/allOf). NOT gated on `isCerebrasMode` — that helper is proxy-blind
(`api.elizacloud.ai` + `OPENAI_API_KEY` looks like plain OpenAI, the exact
deployment where #11123 fired). Lossless: `parseAndValidate`
(runtime/validated-model-call.ts) re-checks the caller's ORIGINAL schema
app-side, so real bounds still gate the returned value.

## 4. Live proof of the transform (real exported function → real cloud)

`__INTERNAL_sanitizeJsonSchema` run on a schema carrying `maxItems`+`minLength`,
then both the raw and sanitized forms sent to the live endpoint:

```
sanitized has maxItems?  false
sanitized has minLength? false
raw (maxItems+minLength) → REJECTED {"error":{"message":"Bad Request","code":500}}
sanitized (stripped)     → OK
```

## 5. Unit coverage (mutation-checked)

New `__tests__/sanitize-json-schema.shape.test.ts` (15 tests): every rejected
keyword is stripped + folded into description at any depth (nested arrays,
anyOf); every accepted keyword is preserved; existing descriptions are kept;
the pre-existing additionalProperties/required behavior is unchanged. Disabling
the strip call turns 10 of 15 red (mutation check performed).

- Full plugin shape suite: 78/78. `tsgo --noEmit` clean. Build clean. Biome clean.

## Scope boundary (deliberately NOT done centrally)

Injecting `properties: {}` on bare object nodes is NOT centralized: the two
Cerebras validators disagree — the TOOL grammar rejects empty `properties:{}`
(wants a real property or anyOf; see text.ts:431-436 + `normalizeSchemaForCerebras`),
while response_format REQUIRES it (#11123 live bisection). So that stays
surface-specific: per-schema on the response_format side (#11123/#11129 handled
today's reflection schemas), `normalizeSchemaForCerebras` on the tool side.

## N/A rows

- Screenshots / video / frontend logs: N/A — provider schema-transform, no UI.
- Live-LLM trajectory file: the §2/§4 live captures ARE the model interaction
  (request schema + response) for the changed transform; the calls carry a
  fixed prompt, no agent/action behavior changed.
