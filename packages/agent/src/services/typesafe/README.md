# TypeSafe decision adapter

This is an inactive, server-side HTTP client for explicitly requested TypeSafe
decisions. Nothing registers it with the runtime, reads an environment key,
changes Cerebras, dispatches tools, or uploads conversation history. Construction
does not perform a request. Only an explicit `systemOne(...)` call sends data.

The implementation uses existing `fetch`, Zod, and `ElizaError`; it adds no package
dependency. The public [HTTP contract](https://docs.typesafe.ai/api) was reviewed
on **2026-09-15**, alongside the official JavaScript SDK
[`@typesafe-ai/sdk` v0.5.7](https://github.com/typesafe-ai/typesafe-sdk-js/tree/v0.5.7)
([release notes](https://docs.typesafe.ai/sdk/javascript/changelog)). This is an
independent adapter, not the vendor SDK or an OpenAI-compatible provider.

## Supported contract

`POST https://api.typesafe.ai/v1/systemone` uses bearer authentication and a JSON
body containing explicit `model`, `state`, and named `questions`. The response
contains `model`, matching `answers`, and `usage.input_tokens` /
`usage.output_tokens`.

The adapter deliberately supports the common documented HTTP subset:

| Question | Input | Answer |
| --- | --- | --- |
| Choice | Named options with string or null descriptions | Selected option, probability map, confidence |
| Score | Ordered array of at least two string descriptions | Fractional score, complete legend, probabilities, confidence |
| Noul | Yes/no question; optional string `true` / `false` criteria | Probability of yes; no separate confidence |

`state` and each question's required `instructions` accept strings, JSON objects,
or JSON arrays. Some SDK types support a broader interface, including null state,
optional instructions, structured criteria, and score maps; those extensions
are not implemented here. Questions are independent and share state; their map
keys identify answers but do not supply instructions to the model.
See [advanced primitives](https://docs.typesafe.ai/primitives/advanced) and the
[SDK types](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.5.7/src/types.ts).

Request validation rejects unsupported values rather than silently changing
them. Undefined values, non-finite numbers, cyclic objects, getters, sparse
arrays, and custom object serialization are unsupported. Complete accepted JSON
is sent without slicing or summarization, including unusual dictionary keys.
Response validation rejects extra/missing question answers, unknown fields or
types, mismatched labels/levels, invalid usage, and invalid probabilities.
Probability sums allow an absolute tolerance of 0.0001 or a nonzero distribution
consistent with rounding each value to hundredths, as observed from live Jev
1.13.0. The adapter preserves the returned values without normalization. This
is transport validation, not a confidence calibration or accuracy guarantee.

## Explicit use

```ts
import { TypeSafeDecisionClient } from "./client";

// The caller supplies an already-authorized, server-held key.
const client = new TypeSafeDecisionClient({ apiKey: serverHeldKey });
const result = await client.systemOne({
  model: "jev-latest",
  state: "Synthetic example: a billing question.",
  questions: {
    category: {
      type: "choice",
      instructions: "Classify the example by department.",
      criteria: { billing: "Payments", technical: "Technical faults" },
    },
  },
}, { signal: cancellationSignal });
```

The API key is mandatory. `endpoint` optionally specifies a complete HTTPS
evaluation URL; credentials, queries, fragments, and redirects are rejected.
There is no model default: the caller chooses a model and records the returned
version. `jev-latest` is a mutable vendor alias, not a reproducibility pin.

`timeoutMs` defaults to 10,000 and must be an integer from 1 through 60,000. This
is a local total transport/body deadline, not a provider context limit. The
client honors `AbortSignal`, makes one attempt, and never retries automatically.
Caller cancellation reasons, credentials, state, remote error bodies, and raw
transport causes are excluded from errors. `TYPESAFE_HTTP` exposes only status;
other codes distinguish configuration, invalid input/response, transport,
cancellation, timeout, and browser use. A host boundary must handle these errors
explicitly; no error produces a fabricated decision.

## Access, cost, and acceptance

Access requires a TypeSafe account and API key; documented access instructions
are not proof this account has been admitted from the waitlist.
See the [quickstart](https://docs.typesafe.ai/introduction/quickstart).

On 2026-09-15, TypeSafe advertised **$42 per billion input tokens**
(**$0.042 per million**) and **free output** in its
[launch announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev).
These are vendor claims at that date, not verified account pricing or a latency
SLA. A synthetic-only live comparison on 2026-09-16 verified credential access and
returned model `jev-1.13.0`; deployed billing and end-to-end Eliza latency remain
unverified.

The tests use synthetic HTTP responses and exercise the real client boundary.
They do not establish real model correctness, confidence calibration, latency,
cost, or Eliza integration. Jev produces finite decisions, not free-form replies
or arbitrary tool arguments, so Cerebras remains necessary for those paths.

Before enabling any runtime path, use authorized public/synthetic fixtures to
measure current model availability, repeatability, decision quality, confidence
coverage, token usage, and end-to-end latency against a matched Cerebras control.
Do not send app/private traces merely because an API key becomes available.
Existing executor permissions, action constraints, history, and recovery remain
authoritative. No confidence score overrides them.

Run the focused deterministic tests from the repository root with Node 24:

```sh
node packages/scripts/run-vitest.mjs run --config packages/agent/vitest.config.ts packages/agent/src/services/typesafe/client.test.ts
```
