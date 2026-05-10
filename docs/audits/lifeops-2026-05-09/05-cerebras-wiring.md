# LifeOps eval/training -> Cerebras gpt-oss-120b wiring map

Date: 2026-05-09
Working tree: `/Users/shawwalters/milaidy/eliza/` only.
Standing direction: All lifeops EVAL and TRAINING runs use Cerebras `gpt-oss-120b`.
Anthropic Claude Opus 4.7 stays for the agent under test (production runtime).

Cerebras env (already in `eliza/.env`):

- `CEREBRAS_API_KEY=csk-...`
- `CEREBRAS_BASE_URL=https://api.cerebras.ai/v1`
- `CEREBRAS_MODEL=gpt-oss-120b`
- `EVAL_MODEL_PROVIDER=cerebras`, `EVAL_MODEL=gpt-oss-120b`
- `TRAIN_MODEL_PROVIDER=cerebras`, `TRAIN_MODEL=gpt-oss-120b`
- aliases: `EVAL_PROVIDER`, `TRAINING_PROVIDER`, `TRAINING_MODEL`

The Cerebras endpoint is OpenAI-compatible (`POST /chat/completions`),
so the wiring strategy is uniform: every eval/training callsite gets
routed through one shared client built from the env vars above.

---

## 1) Inventory: every eval/judge/training LLM callsite

Categorization legend:

- **EVAL/JUDGE** — scores or grades the agent under test. Must move to Cerebras.
- **TRAINING** — generates synthetic data, optimizes prompts, scores
  candidates during a training run. Must move to Cerebras.
- **RUNTIME** — production agent path. **Stays on Anthropic.** Listed for
  exclusion clarity.

### A. LifeOps in-process judge (live e2e)

| # | File:line | Current provider/model | Category | Notes |
|---|---|---|---|---|
| 1 | `eliza/plugins/app-lifeops/test/helpers/lifeops-live-judge.ts:75-102` (`callOpenAiCompatible`) | OpenAI/Cerebras/Groq/OpenRouter via raw `fetch(${baseUrl}/chat/completions)` | **EVAL/JUDGE** | Default branch in `resolveProviderModelConfig` (line 62-72) — uses `OPENAI_*` env. |
| 2 | `eliza/plugins/app-lifeops/test/helpers/lifeops-live-judge.ts:104-131` (`callAnthropic`) | Anthropic via `fetch(${baseUrl}/v1/messages)` (line 108) | **EVAL/JUDGE** | Hit when `provider.name === "anthropic"`. Today this means the lifeops live test reuses the same provider it is testing, which is exactly the conflation we are removing. |
| 3 | `eliza/plugins/app-lifeops/test/helpers/lifeops-live-judge.ts:133-156` (`callGoogle`) | Google generative API | **EVAL/JUDGE** | Same — judge uses agent provider. |
| 4 | `eliza/plugins/app-lifeops/test/helpers/lifeops-live-judge.ts:223-248` (`judgeTextWithLlm`) | Dispatches to one of the above three | **EVAL/JUDGE** | Top-level entry. Single call from `lifeops-chat.live.e2e.test.ts:87`. |

The lifeops e2e judge today **picks the provider used by the live runtime**
(see `lifeops-live-harness.ts:256-377` `selectLifeOpsLiveProvider` →
`SelectedLiveProvider`). Once the agent under test runs on Anthropic
(Opus 4.7), this code grades Opus output with Opus output. That is exactly
what the redirect to Cerebras fixes.

### B. Scenario-runner judge (the framework-wide LLM-as-judge)

| # | File:line | Current provider/model | Category | Notes |
|---|---|---|---|---|
| 5 | `eliza/packages/scenario-runner/src/judge.ts:128-132` | `runtime.useModel(ModelType.TEXT_LARGE, …)` | **EVAL/JUDGE** | The agent runtime itself is the judge. Whatever provider the runtime is configured with judges its own output. Same drift as #2-#4. |
| 6 | `eliza/packages/scenario-runner/src/executor.ts:1298-1302` (`responseJudge` per turn) | Calls `judgeTextWithLlm(runtime, …)` from #5 | **EVAL/JUDGE** | One call per turn that has `responseJudge`. |
| 7 | `eliza/packages/scenario-runner/src/executor.ts:1341` (`judgeRubric` final check) | Calls `judgeTextWithLlm(runtime, …)` from #5 | **EVAL/JUDGE** | One call per scenario that declares `judgeRubric` final check. Used by `eliza/plugins/app-lifeops/scenarios/brush-teeth-smalltalk-preference.json` and `goal-sleep-basic.json`. |

### C. Training: native optimizer (MIPRO / GEPA / bootstrap-fewshot)

| # | File:line | Current provider/model | Category | Notes |
|---|---|---|---|---|
| 8 | `eliza/plugins/app-training/src/core/training-orchestrator.ts:319-329` (`extractUseModel`) | `runtime.useModel("TEXT_LARGE", …)` (line 327) | **TRAINING** | This is the choke point that hands a `useModel` adapter to the native backend. Every native optimizer call (instruction-search/MIPRO, prompt-evolution/GEPA, bootstrap-fewshot) flows through this single function. |
| 9 | `eliza/plugins/app-training/src/backends/native.ts:200-201` | `createRuntimeAdapter(options.runtime.useModel)` | **TRAINING** | Builds the `LlmAdapter` that all three optimizers consume for variant generation and scoring. |
| 10 | `eliza/plugins/app-training/src/optimizers/scoring.ts:224-240` (`createRuntimeAdapter`) | Wraps `useModel({ prompt, temperature, maxTokens })` | **TRAINING** | Common adapter used by every optimizer. |

### D. Training: synthetic-data teacher models

| # | File:line | Current provider/model | Category | Notes |
|---|---|---|---|---|
| 11 | `eliza/plugins/app-training/src/core/dataset-generator.ts:272-339` (`createAnthropicTeacher`) | Anthropic `claude-sonnet-4-6` (line 311), raw `fetch("https://api.anthropic.com/v1/messages")` | **TRAINING** | Hard-coded Anthropic endpoint + model. |
| 12 | `eliza/plugins/app-training/src/core/dataset-generator.ts:344-410` (`createOpenAITeacher`) | OpenAI `gpt-5.4` (line 363), raw `fetch("https://api.openai.com/v1/chat/completions")` (line 374) | **TRAINING** | Hard-coded OpenAI endpoint + model. |
| 13 | `eliza/plugins/app-training/src/core/cli.ts:71-88` (`getTeacherModel`) | Picks Anthropic over OpenAI based on env keys | **TRAINING** | CLI selector. |
| 14 | `eliza/plugins/app-training/src/routes/training-routes.ts:608-617` | Picks teacher via same Anthropic-then-OpenAI rule | **TRAINING** | UI/API selector for `/api/training/generate`. |
| 15 | `eliza/plugins/app-training/src/routes/training-routes.ts:688-696` | Same as #14 | **TRAINING** | UI/API selector for `/api/training/generate-roleplay`. |

### E. Training: prompt-compare regression checker

| # | File:line | Current provider/model | Category | Notes |
|---|---|---|---|---|
| 16 | `eliza/plugins/app-training/src/core/prompt-compare.ts:242-250` (`resolveAdapter`) | `createRuntimeAdapter(input.runtime.useModel)` | **TRAINING** | Same `useModel` chain as #10. Falls under the same fix. |

### F. Atropos backend (training, but no LLM call)

| # | File:line | Current provider/model | Category | Notes |
|---|---|---|---|---|
| 17 | `eliza/plugins/app-training/src/backends/atropos.ts:45-83` (`runAtroposBackend`) | `spawnSync(ATROPOS_BIN, …)` | **TRAINING (no LLM)** | Pure CLI dispatcher. No model call to redirect. The Atropos process itself does its own training. Out of scope for this audit. |

### G. Tinker backend

| File | Notes |
|---|---|
| `eliza/plugins/app-training/src/backends/tinker.ts` | Job submitter only, no inline LLM calls. Out of scope. |

### H. Production callsites (RUNTIME — explicitly NOT touched)

These call `runtime.useModel(TEXT_LARGE)` from inside the agent during a real
user turn. They must keep flowing through the agent runtime's primary
provider (Anthropic Opus 4.7).

| File:line | Why it stays |
|---|---|
| `eliza/plugins/app-lifeops/src/lifeops/goal-semantic-evaluator.ts:238, 252` | Production goal-progress feature — runs against the user's data when they review a goal. Not an eval/training callsite. |
| `eliza/plugins/app-lifeops/src/lifeops/checkin/checkin-service.ts` | Runtime check-in. |
| `eliza/plugins/app-lifeops/src/actions/resolve-request.ts`, `actions/lib/extract-life-operation.ts`, `actions/lib/lifeops-deferred-draft.ts`, `actions/website-block.ts` | Action handlers. |
| `eliza/plugins/app-lifeops/src/activity-profile/proactive-worker.ts`, `proactive-planner.ts` | Background workers in the running agent. |

These are listed only to make the boundary explicit: do **not** swap them.

---

## 2) Patch plan — one shared helper

Single new file. Every eval/training callsite either consumes it directly
or has `useModel` swapped out at the boundary where the runtime hands the
adapter to optimizers / judges.

### 2.1 The helper

**New file: `eliza/plugins/app-lifeops/test/helpers/lifeops-eval-model.ts`**

```ts
/**
 * Shared eval/training LLM client.
 *
 * All lifeops *evaluation* and *training* callsites route through this
 * helper. The helper reads Cerebras credentials + model from the
 * environment and exposes:
 *
 *   - getEvalModelClient()       — for judge/eval callsites
 *   - getTrainingModelClient()   — for training/teacher/optimizer callsites
 *   - judgeWithCerebras(prompt)  — small convenience wrapper used by judges
 *
 * The two `getX` helpers return identical clients today (both Cerebras
 * gpt-oss-120b) but stay separate so the EVAL_* and TRAIN_* env vars can
 * diverge without code churn.
 *
 * Every call here is a single `POST <baseUrl>/chat/completions`. Cerebras
 * is OpenAI-compatible, so the body matches the OpenAI Chat Completions
 * shape exactly.
 *
 * IMPORTANT: This helper must NEVER be used to drive the agent under
 * test. The agent under test runs on Anthropic (Opus 4.7) or whichever
 * provider the live runtime picked. This helper is for grading and
 * training that agent's output, not for producing it.
 */

interface ResolvedClientConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  role: "eval" | "training";
}

export interface CerebrasChatRequest {
  prompt: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface CerebrasChatResponse {
  text: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
}

export type EvalModelClient = (req: CerebrasChatRequest) => Promise<CerebrasChatResponse>;

function readEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value && value.length > 0) return value;
  }
  return undefined;
}

function resolveCerebrasApiKey(role: "eval" | "training"): string {
  const apiKey =
    readEnv(
      role === "eval" ? "EVAL_CEREBRAS_API_KEY" : "TRAIN_CEREBRAS_API_KEY",
      "CEREBRAS_API_KEY",
      "ELIZA_E2E_CEREBRAS_API_KEY",
    );
  if (!apiKey) {
    throw new Error(
      `[${role}-model] CEREBRAS_API_KEY is not set. ` +
        `Eval/training runs require Cerebras credentials. ` +
        `Set CEREBRAS_API_KEY in eliza/.env.`,
    );
  }
  return apiKey;
}

function resolveBaseUrl(): string {
  return readEnv("CEREBRAS_BASE_URL") ?? "https://api.cerebras.ai/v1";
}

function resolveEvalModel(): string {
  return (
    readEnv("EVAL_MODEL", "EVAL_MODEL_NAME") ??
    readEnv("CEREBRAS_MODEL") ??
    "gpt-oss-120b"
  );
}

function resolveTrainingModel(): string {
  return (
    readEnv("TRAIN_MODEL", "TRAINING_MODEL", "TRAIN_MODEL_NAME") ??
    readEnv("CEREBRAS_MODEL") ??
    "gpt-oss-120b"
  );
}

function resolveProvider(role: "eval" | "training"): string {
  return (
    readEnv(
      role === "eval" ? "EVAL_MODEL_PROVIDER" : "TRAIN_MODEL_PROVIDER",
      role === "eval" ? "EVAL_PROVIDER" : "TRAINING_PROVIDER",
    ) ?? "cerebras"
  );
}

function resolveConfig(role: "eval" | "training"): ResolvedClientConfig {
  const provider = resolveProvider(role);
  if (provider !== "cerebras") {
    throw new Error(
      `[${role}-model] only the "cerebras" provider is wired today; ` +
        `got "${provider}". Set ${
          role === "eval" ? "EVAL_MODEL_PROVIDER" : "TRAIN_MODEL_PROVIDER"
        }=cerebras.`,
    );
  }
  return {
    apiKey: resolveCerebrasApiKey(role),
    baseUrl: resolveBaseUrl(),
    model: role === "eval" ? resolveEvalModel() : resolveTrainingModel(),
    role,
  };
}

async function callCerebras(
  config: ResolvedClientConfig,
  req: CerebrasChatRequest,
): Promise<CerebrasChatResponse> {
  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (req.systemPrompt && req.systemPrompt.length > 0) {
    messages.push({ role: "system", content: req.systemPrompt });
  }
  messages.push({ role: "user", content: req.prompt });

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: req.temperature ?? 0,
      max_tokens: req.maxTokens ?? 1024,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `[${config.role}-model] cerebras error ${response.status}: ${body.slice(0, 300)}`,
    );
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    usage: data.usage
      ? {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
        }
      : undefined,
  };
}

export function getEvalModelClient(): EvalModelClient {
  const config = resolveConfig("eval");
  return (req) => callCerebras(config, req);
}

export function getTrainingModelClient(): EvalModelClient {
  const config = resolveConfig("training");
  return (req) => callCerebras(config, req);
}

/**
 * Convenience wrapper used by lifeops-live-judge.ts and the scenario-runner
 * judge. Returns just the assistant text.
 */
export async function judgeWithCerebras(
  prompt: string,
  options?: { maxTokens?: number; temperature?: number },
): Promise<string> {
  const client = getEvalModelClient();
  const result = await client({
    prompt,
    temperature: options?.temperature ?? 0,
    maxTokens: options?.maxTokens ?? 700,
  });
  return result.text;
}

/**
 * Adapter for the training optimizer/teacher boundary. Returns a function
 * shaped like `runtime.useModel("TEXT_LARGE", { prompt, temperature, maxTokens })`
 * so the existing native backend / prompt-compare consumer code does not
 * change shape.
 */
export function getTrainingUseModelAdapter(): (input: {
  prompt: string;
  temperature?: number;
  maxTokens?: number;
}) => Promise<string> {
  const client = getTrainingModelClient();
  return async (input) => {
    const result = await client({
      prompt: input.prompt,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
    });
    return result.text;
  };
}
```

### 2.2 Per-callsite changes

Every change is one-line / few-lines and consumes the helper. No callsite
keeps its own provider switch.

#### Callsite #1-#4 — `lifeops-live-judge.ts`

**Replace** the entire `resolveProviderModelConfig` / `callAnthropic` /
`callGoogle` / `callOpenAiCompatible` / `callProvider` cluster with a
single Cerebras call. The `provider` argument is kept on the function
signature for backwards compatibility but is now ignored.

Patch (in `eliza/plugins/app-lifeops/test/helpers/lifeops-live-judge.ts`):

```ts
// at the top
import { judgeWithCerebras } from "./lifeops-eval-model.ts";

// delete: ProviderModelConfig, resolveProviderModelConfig,
//         callOpenAiCompatible, callAnthropic, callGoogle, callProvider.

// in judgeTextWithLlm (line 239), replace:
//   const raw = await callProvider(args.provider, prompt);
// with:
const raw = await judgeWithCerebras(prompt, { maxTokens: 700 });
```

`SelectedLiveProvider` import becomes unused; drop it. The function
keeps `provider` as an accepted-but-ignored field on its argument
record so the single caller (`lifeops-chat.live.e2e.test.ts:87`) does
not need to change.

**Risk:** none for the agent under test. The agent still runs on
whatever provider the live runtime picked. Only the *judging* call
moves to Cerebras.

#### Callsite #5-#7 — scenario-runner judge

**`eliza/packages/scenario-runner/src/judge.ts:116-152`** —
replace `runtime.useModel(ModelType.TEXT_LARGE, …)` with the Cerebras
client.

Patch:

```ts
// at the top of judge.ts, alongside existing imports
import { getEvalModelClient } from "../../../plugins/app-lifeops/test/helpers/lifeops-eval-model.ts";

// inside judgeTextWithLlm (line 127-149), replace the for-loop body's
// useModel call:
//
//   const output = await runtime.useModel(ModelType.TEXT_LARGE, {
//     prompt, maxTokens: MAX_JUDGE_TOKENS, temperature: 0,
//   });
//
// with:
const evalClient = getEvalModelClient();
const result = await evalClient({
  prompt,
  temperature: 0,
  maxTokens: MAX_JUDGE_TOKENS,
});
const raw = result.text;
```

The `runtime` parameter is still accepted (the existing executor calls
pass it) but is no longer used inside `judgeTextWithLlm`. We can leave
it for compatibility; remove on a future pass.

**Risk:** the scenario runner currently uses the runtime's primary
provider for both running the agent and judging it. Switching the
judge call to Cerebras keeps the agent unaffected — `runtime.useModel`
calls from action handlers, providers, etc. continue to flow through
Anthropic. Verified by reading executor.ts lines 1298 and 1341 (they
only pass `runtime` to `judgeTextWithLlm`; everything else uses
`runtime.useModel` directly).

#### Callsite #8-#10 + #16 — native optimizer + prompt-compare

The single boundary is `extractUseModel` in
`training-orchestrator.ts:319-329`. Today it returns
`runtime.useModel("TEXT_LARGE", …)`. Replace it with the Cerebras
training adapter — but only when `TRAIN_MODEL_PROVIDER=cerebras` is
set, so unit tests that pass a stub runtime keep working.

Patch in `eliza/plugins/app-training/src/core/training-orchestrator.ts`:

```ts
// at the top, alongside existing imports
import { getTrainingUseModelAdapter } from "../../../app-lifeops/test/helpers/lifeops-eval-model.js";

// replace extractUseModel (lines 319-329) with:
function extractUseModel(runtime: RuntimeLike): UseModelLike | null {
  // Standing direction: training optimizer calls go through Cerebras
  // gpt-oss-120b, NOT through the agent's primary provider.
  const provider = process.env.TRAIN_MODEL_PROVIDER?.trim()
    ?? process.env.TRAINING_PROVIDER?.trim();
  if (provider === "cerebras") {
    return getTrainingUseModelAdapter();
  }

  // Fallback (used by unit tests and operator-overridden setups):
  // route through the runtime's TEXT_LARGE.
  const candidate = runtime as RuntimeLike & UseModelRuntime;
  if (typeof candidate.useModel !== "function") return null;
  return async (input) => candidate.useModel?.("TEXT_LARGE", input);
}
```

This single change covers:
- callsite #8 (native backend dispatcher in this same file)
- callsite #9 (`runNativeBackend(... runtime: { useModel } ...)` in
  `backends/native.ts`)
- callsite #10 (`createRuntimeAdapter` in `optimizers/scoring.ts`,
  which is what every optimizer — instruction-search/MIPRO,
  prompt-evolution/GEPA, bootstrap-fewshot — consumes)

For callsite #16 (`prompt-compare.ts:resolveAdapter`), do the same
boundary swap so any caller that passes `{ runtime }` instead of
`{ adapter }` benefits:

Patch in `eliza/plugins/app-training/src/core/prompt-compare.ts`:

```ts
// at the top, alongside existing imports
import { getTrainingUseModelAdapter } from "../../../app-lifeops/test/helpers/lifeops-eval-model.js";

// replace resolveAdapter (lines 242-250) with:
function resolveAdapter(input: PromptComparisonInput): LlmAdapter {
  if (input.adapter) return input.adapter;
  const provider = process.env.TRAIN_MODEL_PROVIDER?.trim()
    ?? process.env.TRAINING_PROVIDER?.trim();
  if (provider === "cerebras") {
    return createRuntimeAdapter(getTrainingUseModelAdapter());
  }
  if (!input.runtime) {
    throw new Error(
      "[prompt-compare] either `runtime` or `adapter` must be provided",
    );
  }
  return createRuntimeAdapter(input.runtime.useModel);
}
```

**Risk:** the runtime is *not* called for training when
`TRAIN_MODEL_PROVIDER=cerebras`. The agent under test is unaffected
because the agent's `useModel` is invoked via separate, untouched
codepaths (action handlers, providers, evaluators). Native optimizer
runs that previously called Anthropic Opus 4.7 to grade prompt
variants now call Cerebras gpt-oss-120b — that is the intended change.

#### Callsite #11-#15 — synthetic-data teacher

Two options. Pick one.

**Option A (preferred, smallest diff):** add a new
`createCerebrasTeacher` factory next to the existing two and route
the selectors through it whenever `TRAIN_MODEL_PROVIDER=cerebras`.

Patch in `eliza/plugins/app-training/src/core/dataset-generator.ts`
(append after `createOpenAITeacher`):

```ts
import { getTrainingModelClient } from "../../../app-lifeops/test/helpers/lifeops-eval-model.js";

export function createCerebrasTeacher(
  runtime?: IAgentRuntime,
): TeacherModel {
  const client = getTrainingModelClient();
  return {
    name: "cerebras/gpt-oss-120b",
    async generate(systemPrompt: string, userPrompt: string): Promise<string> {
      return await withStandaloneTrajectory(
        runtime,
        {
          source: "training",
          metadata: {
            provider: "cerebras",
            model: process.env.TRAIN_MODEL?.trim() ?? "gpt-oss-120b",
            purpose: "teacher",
          },
        },
        async () => {
          const details: RecordLlmCallDetails = {
            model: `cerebras/${process.env.TRAIN_MODEL?.trim() ?? "gpt-oss-120b"}`,
            modelVersion: process.env.TRAIN_MODEL?.trim() ?? "gpt-oss-120b",
            systemPrompt,
            userPrompt,
            temperature: 0.9,
            maxTokens: 4096,
            purpose: "training.teacher",
            actionType: "training.teacher.cerebras.generate",
          };
          return await recordLlmCall(runtime, details, async () => {
            const result = await client({
              prompt: userPrompt,
              systemPrompt,
              temperature: 0.9,
              maxTokens: 4096,
            });
            details.promptTokens = result.usage?.promptTokens;
            details.completionTokens = result.usage?.completionTokens;
            return result.text;
          });
        },
      );
    },
  };
}
```

Then in `cli.ts:71-88` (`getTeacherModel`) and
`training-routes.ts:608-617` and `training-routes.ts:688-696`, prefer
Cerebras whenever the provider env says so:

```ts
function getTeacherModel(): TeacherModel {
  const trainProvider = process.env.TRAIN_MODEL_PROVIDER?.trim()
    ?? process.env.TRAINING_PROVIDER?.trim();
  if (trainProvider === "cerebras") {
    console.log("Using Cerebras gpt-oss-120b as teacher model");
    return createCerebrasTeacher();
  }
  // ...existing Anthropic / OpenAI fallback unchanged...
}
```

The same three-line preface goes in front of each
`anthropicKey ? createAnthropicTeacher : createOpenAITeacher` line in
`training-routes.ts`.

**Option B:** delete `createAnthropicTeacher` and `createOpenAITeacher`
and replace both with the Cerebras teacher only. Cleaner but breaks
operators who deliberately want a non-Cerebras teacher. Not recommended
without a wider product decision.

**Risk:** the agent under test never goes through these teachers — the
teacher generates *training conversations*, not the agent's response.
Switching the teacher to Cerebras gpt-oss-120b only affects synthetic
data quality. Acceptable per the standing direction.

---

## 3) Verification recipe

A tiny smoke script that confirms the wiring works without running
real test data. Save as
`eliza/plugins/app-lifeops/scripts/verify-cerebras-wiring.ts` and run
with `bun run eliza/plugins/app-lifeops/scripts/verify-cerebras-wiring.ts`
(or `bun run` it directly):

```ts
import {
  getEvalModelClient,
  getTrainingModelClient,
} from "../test/helpers/lifeops-eval-model.ts";

async function main(): Promise<void> {
  console.log("[verify-cerebras] starting smoke test");

  // 1. EVAL client
  const evalClient = getEvalModelClient();
  const evalResult = await evalClient({
    prompt: 'Reply with the JSON {"ok": true} and nothing else.',
    maxTokens: 32,
    temperature: 0,
  });
  console.log("[verify-cerebras] eval text:", evalResult.text);
  console.log("[verify-cerebras] eval usage:", evalResult.usage);
  if (!evalResult.text.includes("ok")) {
    throw new Error("eval client did not return parseable JSON");
  }

  // 2. TRAINING client
  const trainClient = getTrainingModelClient();
  const trainResult = await trainClient({
    prompt: "Generate one short user message asking for tomorrow's weather.",
    systemPrompt: "You produce realistic synthetic training utterances.",
    maxTokens: 64,
    temperature: 0.9,
  });
  console.log("[verify-cerebras] train text:", trainResult.text);
  console.log("[verify-cerebras] train usage:", trainResult.usage);
  if (trainResult.text.trim().length === 0) {
    throw new Error("training client returned empty text");
  }

  console.log("[verify-cerebras] OK — Cerebras gpt-oss-120b is reachable for both eval and training");
}

await main();
```

Expected output (abbreviated):

```
[verify-cerebras] starting smoke test
[verify-cerebras] eval text: {"ok": true}
[verify-cerebras] eval usage: { promptTokens: 19, completionTokens: 7 }
[verify-cerebras] train text: hey what's the forecast for tomorrow?
[verify-cerebras] train usage: { promptTokens: 35, completionTokens: 12 }
[verify-cerebras] OK — Cerebras gpt-oss-120b is reachable for both eval and training
```

Failure modes the script catches:

- Missing `CEREBRAS_API_KEY` -> the helper throws with a clear
  diagnostic.
- Wrong base URL (`https://api.cerebras.ai/v1`) -> `fetch` returns
  `404` and the helper surfaces the body.
- Wrong model id (typo in `CEREBRAS_MODEL`) -> Cerebras returns
  `400 model not found` with the right error string.
- `EVAL_MODEL_PROVIDER` / `TRAIN_MODEL_PROVIDER` set to something
  other than `cerebras` -> helper throws "only the 'cerebras' provider
  is wired today".

---

## 4) Sequencing

1. Create `lifeops-eval-model.ts` (the helper).
2. Run the verification script (above) before touching anything else.
   If it does not pass, the env is wrong; do not proceed.
3. Patch `lifeops-live-judge.ts` (callsites #1-#4).
4. Patch `scenario-runner/src/judge.ts` (callsites #5-#7).
5. Patch `training-orchestrator.ts` `extractUseModel` (callsites
   #8-#10).
6. Patch `prompt-compare.ts` `resolveAdapter` (callsite #16).
7. Add `createCerebrasTeacher` and update `cli.ts` /
   `training-routes.ts` selectors (callsites #11-#15).
8. Run a single live lifeops e2e test (e.g.
   `lifeops-chat.live.e2e.test.ts`) with the agent on Anthropic and
   confirm:
   - Trajectories logged for the agent show
     `model: anthropic/claude-opus-4-7` (or whatever the live runtime
     picked).
   - The judge call logs / network panel show
     `https://api.cerebras.ai/v1/chat/completions` with
     `model: gpt-oss-120b`.
9. Run a single training round (`bun run train -- --backend native
   --optimizer instruction-search --task action_planner`) and confirm
   the optimizer's variant-generation calls hit Cerebras, not the
   runtime provider.

---

## 5) Out-of-scope (deliberate)

- `eliza/plugins/app-training/src/backends/atropos.ts` — pure CLI
  dispatcher.
- `eliza/plugins/app-training/src/backends/tinker.ts` — job submitter.
- All `eliza/plugins/app-lifeops/src/**` runtime callsites — they are
  the agent itself, must stay on Anthropic.
- `eliza/plugins/app-lifeops/src/lifeops/goal-semantic-evaluator.ts`
  — production goal-progress feature, not eval.
- `eliza/packages/agent/src/runtime/eliza.ts` and the OpenAI plugin
  registry — no change. The agent runtime keeps Anthropic Opus 4.7
  as `ANTHROPIC_LARGE_MODEL`.
