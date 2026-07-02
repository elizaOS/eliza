/**
 * S3 GEPA smoke — LIVE, not fabricated.
 *
 * Drives the REAL located optimizer (`runGepa` from
 * plugins/plugin-training/src/optimizers/gepa.ts) + the REAL scorer
 * (`createPromptScorer` + `scoreViewSelection`) against a genuinely-failing
 * `view_context` case, using a LIVE Cerebras `gemma-4-31b` model — the exact
 * model the sanctioned `TRAIN_MODEL_PROVIDER=cerebras` native-backend adapter
 * defaults to (plugins/plugin-training/src/cli/train.ts).
 *
 * The failing case is real: the baseline prompt is a generic "reply to the user"
 * instruction with NO output-shape guidance, so the model emits prose. The
 * scorer (`scoreViewSelection`) can extract no {viewId} from prose, so the
 * baseline scores ~0 = FAIL. GEPA's reflect→mutate loop reads the (prompt,
 * actual, expected) failures, learns the required `{viewId, reason}` JSON
 * contract, and rewrites the prompt so the model now emits a parseable view
 * selection = PASS.
 *
 * Persists the winning artifact through the REAL `OptimizedPromptService`
 * (versioned `vN.json` + `current` symlink + HMAC sidecar) into a scratch
 * state dir, then RELOADS it through a fresh `OptimizedPromptService` to prove
 * the runtime pickup path returns the optimized prompt — the same mechanism
 * that flips a re-run to passing at agent boot.
 *
 * Run:
 *   CEREBRAS_API_KEY=... bun --conditions=eliza-source \
 *     .github/issue-evidence/gpt55-training-pipeline/s3-gepa/smoke-gepa-live.ts
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluatePromotion } from "../../../../plugins/plugin-training/src/core/promotion-gate.js";
import {
  createPromptScorer,
  runGepa,
  scoreViewSelection,
} from "../../../../plugins/plugin-training/src/optimizers/index.js";
import type {
  LlmAdapter,
  OptimizationExample,
} from "../../../../plugins/plugin-training/src/optimizers/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// Curated, learnable view_context dataset (eliza_native_v1). The situation→view
// mapping is obvious from the user text, so the ONLY thing the generic baseline
// lacks is the output contract — exactly the failure GEPA instruction-evolution
// is built to fix. (The plugin's own __fixtures__/view-context.jsonl encodes an
// idiosyncratic mapping — e.g. "task-coordinator" — that needs bootstrap-fewshot
// demonstrations, not prompt rewriting, so it is not a valid GEPA-alone smoke.)
const FIXTURE =
  process.env.DATASET ?? join(HERE, "smoke-dataset-view_context.jsonl");

const CEREBRAS_MODEL = process.env.CEREBRAS_MODEL ?? "gemma-4-31b";
const CEREBRAS_URL =
  process.env.CEREBRAS_BASE_URL ?? "https://api.cerebras.ai/v1";

/**
 * Live Cerebras adapter — OpenAI-compatible /chat/completions, no forced
 * response_format. The PROMPT must earn the output shape; that is what makes
 * the generic baseline genuinely fail and gives GEPA real headroom.
 */
function cerebrasAdapter(): LlmAdapter {
  const key = process.env.CEREBRAS_API_KEY?.trim();
  if (!key) throw new Error("CEREBRAS_API_KEY is required for the live smoke");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    async complete({ system, user, temperature, maxTokens }) {
      const body = JSON.stringify({
        model: CEREBRAS_MODEL,
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          { role: "user", content: user },
        ],
        temperature: temperature ?? 0,
        max_tokens: maxTokens ?? 120,
      });
      // Cerebras shared endpoint throttles under load (429 queue_exceeded) and
      // occasionally 5xx. Retry with exponential backoff + jitter so the smoke
      // rides through transient throttling instead of aborting a live run.
      let lastErr = "";
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const res = await fetch(`${CEREBRAS_URL}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body,
        });
        if (res.ok) {
          const data = (await res.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          return data.choices?.[0]?.message?.content ?? "";
        }
        lastErr = `cerebras ${res.status}: ${await res.text()}`;
        if (res.status !== 429 && res.status < 500) break;
        await sleep(Math.min(30_000, 1_000 * 2 ** attempt) + Math.random() * 500);
      }
      throw new Error(lastErr);
    },
  };
}

function loadDataset(): OptimizationExample[] {
  return readFileSync(FIXTURE, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      const r = JSON.parse(l) as {
        request: { messages: Array<{ content: string }> };
        response: { text: string };
      };
      return {
        id: `row-${i}`,
        input: { user: r.request.messages.at(-1)?.content ?? "" },
        expectedOutput: r.response.text,
      };
    });
}

// Genuinely-inadequate baseline: it lists the view vocabulary but gives NO
// output-shape contract and invites a conversational reply — so the live model
// answers in prose ("I'd suggest opening your calendar..."), from which
// scoreViewSelection can extract no {viewId} => baseline scores ~0 = FAIL.
// The one thing missing is the machine-readable contract; that is precisely
// what GEPA's reflect→mutate loop discovers and bakes in.
const BASELINE =
  "You help decide which single app view would be most useful to open for the " +
  "user. The available views are: calendar, inbox, wallet, finances, todos, " +
  "goals, health, documents, relationships, focus, none. Read the user's " +
  "message and tell them which view is most relevant and why.";

async function main() {
  const dataset = loadDataset();
  const adapter = cerebrasAdapter();
  const scorer = createPromptScorer(adapter, {
    compare: scoreViewSelection,
    maxTokens: 120,
  });

  console.log(
    `[s3-gepa] model=${CEREBRAS_MODEL} dataset=${dataset.length} rows`,
  );

  // Baseline score on the FULL dataset — the honest "before".
  const baselineScore = await scorer(BASELINE, dataset);
  console.log(`[s3-gepa] baseline score (FULL dataset) = ${baselineScore.toFixed(3)}`);

  // Run the REAL GEPA optimizer. Small bounded config keeps the smoke to a
  // few minutes of live calls; the defaults (pop=12, gen=8) are the production
  // sweep values used by the gepa:view-context / native-backend paths.
  const t0 = Date.now();
  const gepa = await runGepa({
    baselinePrompt: BASELINE,
    dataset,
    scorer,
    llm: adapter,
    options: {
      population: 6,
      generations: 3,
      reflectionBatchSize: 3,
      rng: (() => {
        let s = 20260702 >>> 0;
        return () => {
          s = (s * 1664525 + 1013904223) >>> 0;
          return s / 0x100000000;
        };
      })(),
    },
  });
  const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);

  // Optimized score on the FULL dataset — the honest "after".
  const optimizedScore = await scorer(gepa.optimizedPrompt, dataset);
  console.log(
    `[s3-gepa] gepa optimized score (FULL dataset) = ${optimizedScore.toFixed(3)} ` +
      `(gepa internal subset score=${gepa.score.toFixed(3)}, ${elapsedS}s)`,
  );

  // Variance-aware promotion gate — the same #8797 gate the real scripts use.
  const decision = await evaluatePromotion({
    incumbentPrompt: BASELINE,
    candidatePrompt: gepa.optimizedPrompt,
    dataset,
    scorer,
  });
  console.log(
    `[s3-gepa] promotion gate: ${decision.promote ? "PROMOTE" : "REJECT"} (${decision.reason})`,
  );

  // --- REAL persistence + runtime pickup through OptimizedPromptService ---
  const stateDir = mkdtempSync(join(tmpdir(), "s3-gepa-state-"));
  const storeRoot = join(stateDir, "optimized-prompts");
  const artifactPayload = {
    task: "view_context" as const,
    optimizer: "gepa" as const,
    baseline: BASELINE,
    prompt: gepa.optimizedPrompt,
    baselineScore,
    score: optimizedScore,
    datasetSize: dataset.length,
    datasetId: FIXTURE,
    generatedAt: new Date().toISOString(),
    lineage: gepa.lineage,
  };

  const { OptimizedPromptService } = await import("@elizaos/core");
  const writer = new OptimizedPromptService();
  writer.setStoreRoot(storeRoot);
  const artifactPath = await writer.setPrompt("view_context", artifactPayload);
  console.log(`[s3-gepa] persisted artifact -> ${artifactPath}`);

  // Fresh service instance = the runtime boot path. refresh() scans disk and
  // getPrompt() returns the optimized prompt the agent will actually use.
  const reader = new OptimizedPromptService();
  reader.setStoreRoot(storeRoot);
  await reader.refresh();
  const loaded = reader.getPrompt("view_context");
  const meta = reader.getMetadata("view_context");
  const pickupOk =
    loaded?.prompt === gepa.optimizedPrompt && loaded?.optimizerSource === "gepa";
  console.log(
    `[s3-gepa] runtime pickup: ${pickupOk ? "OK" : "FAIL"} ` +
      `(optimizer=${loaded?.optimizerSource}, score=${meta?.score.toFixed(3)})`,
  );

  const outcome =
    optimizedScore > baselineScore ? "FLIPPED (fail -> improved)" : "NO IMPROVEMENT";
  console.log(`[s3-gepa] OUTCOME: ${outcome}`);

  const report = {
    model: CEREBRAS_MODEL,
    datasetRows: dataset.length,
    baselinePrompt: BASELINE,
    baselineScore,
    optimizedScore,
    gepaInternalSubsetScore: gepa.score,
    delta: optimizedScore - baselineScore,
    outcome,
    elapsedSeconds: Number(elapsedS),
    promotion: decision,
    runtimePickupOk: pickupOk,
    persistedArtifactPath: artifactPath,
    optimizedPrompt: gepa.optimizedPrompt,
    lineage: gepa.lineage,
  };
  writeFileSync(join(HERE, "smoke-report.json"), JSON.stringify(report, null, 2));
  // Copy the persisted artifact (with lineage) next to the report for review.
  writeFileSync(
    join(HERE, "artifact-view_context.json"),
    readFileSync(artifactPath, "utf8"),
  );
  console.log(`[s3-gepa] wrote smoke-report.json + artifact-view_context.json`);

  if (!pickupOk) process.exitCode = 1;
}

main().catch((err) => {
  console.error("[s3-gepa] smoke failed:", err);
  process.exit(1);
});
