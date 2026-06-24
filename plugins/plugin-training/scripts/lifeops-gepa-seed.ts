#!/usr/bin/env bun
/**
 * Seed-dataset GEPA optimizer for a LifeOps per-capability task, run against
 * gpt-oss-120b on Cerebras (#9299, Scope 5).
 *
 * Unlike `lifeops:gepa` (which buckets recorded trajectories), this entrypoint
 * carries a small, hand-curated seed dataset so the GEPA loop can run before
 * any trajectories have been captured. It reuses the real building blocks:
 *   - the GEPA optimizer (`runGepa`) + LifeOps scorer (`scoreLifeOpsTask`),
 *   - the existing Cerebras gpt-oss-120b client (`getTrainingUseModelAdapter`),
 *   - the standard optimized-prompt store (`OptimizedPromptService.setPrompt`),
 *     so the artifact auto-loads at boot.
 *
 * It prints the measured before/after score and persists the optimized prompt.
 *
 *   TRAIN_MODEL_PROVIDER=cerebras CEREBRAS_API_KEY=... \
 *     bun run --cwd plugins/plugin-training scripts/lifeops-gepa-seed.ts \
 *       --task calendar_extract [--apply] [--generations 2] [--population 4]
 *
 * Without `--apply` it runs the optimization and reports metrics but does not
 * persist (dry run).
 */
import { parseArgs } from "node:util";
import {
  type OptimizedPromptArtifact,
  OptimizedPromptService,
  type OptimizedPromptTask,
} from "@elizaos/core";
// Use the in-package training model client. plugin-training ships its own
// Cerebras/Anthropic adapter precisely so scripts here never import across
// another package's `test/` boundary (see src/core/cerebras-eval-model.ts).
import { getTrainingUseModelAdapter } from "../src/core/cerebras-eval-model.ts";
import {
  createPromptScorer,
  createRuntimeAdapter,
  type OptimizationExample,
  runGepa,
  scoreLifeOpsTask,
} from "../src/optimizers/index.ts";

interface SeedTask {
  task: OptimizedPromptTask;
  baseline: string;
  dataset: OptimizationExample[];
}

// The optimized `calendar_extract` prompt AUTO-LOADS into the live calendar
// planner (plugin-calendar calendar-handler.ts → resolveOptimizedPromptForRuntime
// (runtime, "calendar_extract", CALENDAR_PLAN_INSTRUCTIONS)), whose output is
// parsed into a CalendarLlmPlan: { subaction, shouldAct, response, queries,
// title, tripLocation, timeMin, timeMax, windowLabel }. The seed dataset MUST
// therefore optimize for that PLAN shape — not a free-form event record — or an
// --apply'd artifact would emit fields the planner cannot parse and break it.
//
// Scoring (scoreStructuredFields) credits the keys present in expectedOutput.
// We score the deterministic, language-independent ROUTING decision the planner
// most needs to get right — `subaction` + `shouldAct` — and deliberately omit
// fields that aren't deterministic from the input alone (timeMin/timeMax need
// the runtime's date anchors; queries/windowLabel are free-form).
const CALENDAR_PLAN_FIELDS = [
  "subaction (one of: feed, next_event, search_events, create_event, update_event, delete_event, trip_window; or null for reply-only)",
  "shouldAct (boolean; false when the request is too vague to act on)",
  "response (short natural reply when shouldAct is false, else null)",
  "queries (array of up to 3 search strings)",
  "title (optional event title)",
  "tripLocation (optional place for trip_window)",
  "timeMin / timeMax (optional ISO 8601 window)",
  "windowLabel (optional natural-language window label)",
].join("; ");

const SEED_TASKS: Record<string, SeedTask> = {
  // calendar_extract — natural-language request → calendar PLAN (CalendarLlmPlan).
  // Examples cover the full subaction taxonomy + the shouldAct=false clarify
  // case, across languages. Scored on subaction + shouldAct.
  calendar_extract: {
    task: "calendar_extract",
    baseline: `Plan the calendar action for the user's request. Return a single JSON object only, with these fields: ${CALENDAR_PLAN_FIELDS}.`,
    dataset: [
      {
        input: { user: "What's on my calendar tomorrow?" },
        expectedOutput: JSON.stringify({ subaction: "feed", shouldAct: true }),
      },
      {
        input: { user: "What's my next meeting?" },
        expectedOutput: JSON.stringify({
          subaction: "next_event",
          shouldAct: true,
        }),
      },
      {
        input: { user: "Find my flight to Denver." },
        expectedOutput: JSON.stringify({
          subaction: "search_events",
          shouldAct: true,
        }),
      },
      {
        input: {
          user: "Set up a dentist appointment on March 3rd at 9am at Downtown Dental.",
        },
        expectedOutput: JSON.stringify({
          subaction: "create_event",
          shouldAct: true,
        }),
      },
      {
        input: { user: "Rename my 2pm standup to sprint sync." },
        expectedOutput: JSON.stringify({
          subaction: "update_event",
          shouldAct: true,
        }),
      },
      {
        input: { user: "Cancel my lunch on Friday." },
        expectedOutput: JSON.stringify({
          subaction: "delete_event",
          shouldAct: true,
        }),
      },
      {
        input: { user: "What's happening while I'm in Tokyo next month?" },
        expectedOutput: JSON.stringify({
          subaction: "trip_window",
          shouldAct: true,
        }),
      },
      {
        input: { user: "Can you help me with my calendar?" },
        expectedOutput: JSON.stringify({ subaction: null, shouldAct: false }),
      },
      {
        input: {
          user: "Réserve un rendez-vous chez le médecin mardi à 10h à la clinique du centre.",
        },
        expectedOutput: JSON.stringify({
          subaction: "create_event",
          shouldAct: true,
        }),
      },
      {
        input: { user: "Was steht morgen in meinem Kalender?" },
        expectedOutput: JSON.stringify({ subaction: "feed", shouldAct: true }),
      },
    ],
  },
};

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      task: { type: "string" },
      apply: { type: "boolean" },
      generations: { type: "string" },
      population: { type: "string" },
      "state-dir": { type: "string" },
    },
    allowPositionals: false,
  });

  const taskName = (values.task ?? "calendar_extract").trim();
  const seed = SEED_TASKS[taskName];
  if (!seed) {
    console.error(
      `[gepa-seed] unknown --task "${taskName}". Available: ${Object.keys(SEED_TASKS).join(", ")}`,
    );
    return 1;
  }
  if (values["state-dir"]) {
    process.env.ELIZA_STATE_DIR = values["state-dir"];
  }

  const provider =
    process.env.TRAIN_MODEL_PROVIDER?.trim() ??
    process.env.TRAINING_PROVIDER?.trim();
  if (provider !== "cerebras") {
    console.error(
      "[gepa-seed] TRAIN_MODEL_PROVIDER=cerebras is required (gpt-oss-120b on Cerebras).",
    );
    return 1;
  }

  const useModel = getTrainingUseModelAdapter();
  const adapter = createRuntimeAdapter(useModel);
  const scorer = createPromptScorer(adapter, {
    maxTokens: 256,
    compare: (actual, expected) =>
      scoreLifeOpsTask(seed.task, actual, expected),
  });

  const generations = Number.parseInt(values.generations ?? "2", 10);
  const population = Number.parseInt(values.population ?? "4", 10);
  if (!Number.isInteger(generations) || generations < 1) {
    console.error(
      `[gepa-seed] --generations must be a positive integer (got "${values.generations}").`,
    );
    return 1;
  }
  if (!Number.isInteger(population) || population < 1) {
    console.error(
      `[gepa-seed] --population must be a positive integer (got "${values.population}").`,
    );
    return 1;
  }

  console.log(
    `[gepa-seed] task=${seed.task} dataset=${seed.dataset.length} ` +
      `model=gpt-oss-120b (cerebras) generations=${generations} population=${population}`,
  );

  const result = await runGepa({
    baselinePrompt: seed.baseline,
    dataset: seed.dataset,
    scorer,
    llm: adapter,
    options: {
      generations,
      population,
      reflectionBatchSize: 2,
      maxTokens: 768,
      reflectionMaxTokens: 384,
    },
  });

  console.log(
    `\n[gepa-seed] RESULT task=${seed.task} ` +
      `baseline=${result.baseline.toFixed(3)} optimized=${result.score.toFixed(3)} ` +
      `delta=${(result.score - result.baseline).toFixed(3)}`,
  );
  console.log(`\n[gepa-seed] baseline prompt:\n${seed.baseline}`);
  console.log(`\n[gepa-seed] optimized prompt:\n${result.optimizedPrompt}`);

  if (!values.apply) {
    console.log(
      "\n[gepa-seed] dry run — pass --apply to persist to the optimized-prompt store.",
    );
    return 0;
  }

  // The persisted artifact auto-loads into the live runtime for this task, so
  // never let --apply DEGRADE the production prompt: refuse to persist unless the
  // optimized prompt actually beat the baseline on the seed set.
  if (result.score <= result.baseline) {
    console.error(
      `\n[gepa-seed] refusing to persist: optimized score ${result.score.toFixed(3)} ` +
        `did not beat baseline ${result.baseline.toFixed(3)}. The optimized prompt ` +
        `auto-loads into the live runtime, so a non-improving artifact is not applied.`,
    );
    return 1;
  }

  const artifact: OptimizedPromptArtifact = {
    task: seed.task,
    optimizer: "gepa",
    baseline: seed.baseline,
    prompt: result.optimizedPrompt,
    score: result.score,
    baselineScore: result.baseline,
    datasetId: `seed:${seed.task}`,
    datasetSize: seed.dataset.length,
    generatedAt: new Date().toISOString(),
    lineage: result.lineage.map((entry) => ({
      round: entry.round,
      variant: entry.variant,
      score: entry.score,
      notes: entry.notes,
    })),
  };

  // Service's runtime arg is optional and setPrompt() only touches the on-disk
  // store root — no runtime needed (matches scripts/lifeops-gepa-loop.ts).
  const service = new OptimizedPromptService();
  const path = await service.setPrompt(seed.task, artifact);
  console.log(`\n[gepa-seed] persisted optimized artifact → ${path}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[gepa-seed] failed:", err);
    process.exit(1);
  });
