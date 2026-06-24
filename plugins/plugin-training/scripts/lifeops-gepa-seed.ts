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
import { getTrainingUseModelAdapter } from "../../plugin-personal-assistant/test/helpers/lifeops-eval-model.ts";
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

const SEED_TASKS: Record<string, SeedTask> = {
  // calendar_extract — natural-language scheduling request → structured event
  // JSON. Scored by field agreement (scoreStructuredFields). The baseline is
  // intentionally terse so GEPA has room to improve recall on date/time/
  // location/attendees fields across phrasings and languages.
  calendar_extract: {
    task: "calendar_extract",
    baseline:
      "Extract the calendar event from the user message. Output JSON only.",
    dataset: [
      {
        input: {
          user: "Set up a dentist appointment on March 3rd at 9am for 30 minutes at Downtown Dental.",
        },
        expectedOutput: JSON.stringify({
          title: "Dentist appointment",
          date: "March 3",
          startTime: "9:00 AM",
          endTime: "9:30 AM",
          location: "Downtown Dental",
        }),
      },
      {
        input: {
          user: "Block 2-3pm tomorrow for a 1:1 with Priya in the small conference room.",
        },
        expectedOutput: JSON.stringify({
          title: "1:1 with Priya",
          date: "tomorrow",
          startTime: "2:00 PM",
          endTime: "3:00 PM",
          location: "small conference room",
        }),
      },
      {
        input: {
          user: "Lunch with the Frontier Tower team Friday noon at Tacos El Sol.",
        },
        expectedOutput: JSON.stringify({
          title: "Lunch with Frontier Tower team",
          date: "Friday",
          startTime: "12:00 PM",
          endTime: "1:00 PM",
          location: "Tacos El Sol",
        }),
      },
      {
        input: {
          user: "Schedule a board prep call next Monday from 4 to 5:30 in the evening, remote.",
        },
        expectedOutput: JSON.stringify({
          title: "Board prep call",
          date: "next Monday",
          startTime: "4:00 PM",
          endTime: "5:30 PM",
          location: "remote",
        }),
      },
      {
        input: {
          user: "Réserve un rendez-vous chez le médecin mardi à 10h pour une heure à la clinique du centre.",
        },
        expectedOutput: JSON.stringify({
          title: "Rendez-vous médecin",
          date: "mardi",
          startTime: "10:00 AM",
          endTime: "11:00 AM",
          location: "clinique du centre",
        }),
      },
      {
        input: {
          user: "Put a 45-minute gym session on the calendar every day at 7am at the studio.",
        },
        expectedOutput: JSON.stringify({
          title: "Gym session",
          date: "every day",
          startTime: "7:00 AM",
          endTime: "7:45 AM",
          location: "studio",
        }),
      },
      {
        input: {
          user: "Coffee with David next Wednesday 8:30am, Blue Bottle on Mission.",
        },
        expectedOutput: JSON.stringify({
          title: "Coffee with David",
          date: "next Wednesday",
          startTime: "8:30 AM",
          endTime: "9:00 AM",
          location: "Blue Bottle on Mission",
        }),
      },
      {
        input: {
          user: "Investor call Thursday 3pm for an hour, dial-in.",
        },
        expectedOutput: JSON.stringify({
          title: "Investor call",
          date: "Thursday",
          startTime: "3:00 PM",
          endTime: "4:00 PM",
          location: "dial-in",
        }),
      },
      {
        input: {
          user: "Termin beim Friseur am Samstag um 14 Uhr, eine halbe Stunde, im Salon Schmidt.",
        },
        expectedOutput: JSON.stringify({
          title: "Friseurtermin",
          date: "Samstag",
          startTime: "2:00 PM",
          endTime: "2:30 PM",
          location: "Salon Schmidt",
        }),
      },
      {
        input: {
          user: "Family dinner this Sunday 6pm at mom's house.",
        },
        expectedOutput: JSON.stringify({
          title: "Family dinner",
          date: "this Sunday",
          startTime: "6:00 PM",
          endTime: "7:00 PM",
          location: "mom's house",
        }),
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

  const service = new OptimizedPromptService({} as never);
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
