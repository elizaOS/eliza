/**
 * Boot-load + rendered-prompt verification for persisted LifeOps
 * `OptimizedPromptArtifact`s — the 4 prose/NL capabilities (#11384).
 *
 * Two lanes:
 *
 *   1. Hermetic (always runs): for each task, persists a synthetic artifact
 *      through the real `OptimizedPromptService.setPrompt` into a temp store,
 *      re-boots a fresh service instance against that store (the same
 *      construct-then-`refresh()` scan `start()` performs at agent boot), and
 *      asserts the artifact loads AND changes the output of the task's
 *      PRODUCTION prompt builder — the exact call site the runtime renders.
 *
 *   2. Live (env-gated): when `LIFEOPS_VERIFY_STATE_DIR` names a state dir
 *      that a `lifeops-gepa-seed --apply` run persisted into, boots against
 *      it and prints the real before/after render for every loaded task:
 *
 *        LIFEOPS_VERIFY_STATE_DIR=/path/to/state-dir \
 *          bunx vitest run test/lifeops-optimized-artifact-verify.test.ts
 *
 *      Restrict to one task with `LIFEOPS_VERIFY_TASK=<task>`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import {
  OPTIMIZED_PROMPT_SERVICE,
  type OptimizedPromptArtifact,
  OptimizedPromptService,
  type OptimizedPromptTask,
} from "@elizaos/core";
import {
  buildScreenTimeRecapRules,
  SCREENTIME_RECAP_INSTRUCTIONS,
} from "@elizaos/plugin-health/actions/screen-time";
import { afterAll, describe, expect, it } from "vitest";
import { buildNarrativePrompt } from "../src/actions/brief.js";
import {
  BRIEF_NARRATIVE_INSTRUCTIONS,
  MEETING_PREP_INSTRUCTIONS,
  REMINDER_DISPATCH_INSTRUCTIONS,
} from "../src/lifeops/optimized-prompt-instructions.js";
import { buildReminderDispatchPrompt } from "../src/lifeops/service-mixin-reminders.js";

const VERIFIABLE_TASKS = [
  "reminder_dispatch",
  "meeting_prep",
  "morning_brief",
  "screentime_recap",
] as const satisfies readonly OptimizedPromptTask[];
type VerifiableTask = (typeof VERIFIABLE_TASKS)[number];

const BASELINE_BY_TASK: Record<VerifiableTask, string> = {
  reminder_dispatch: REMINDER_DISPATCH_INSTRUCTIONS,
  meeting_prep: MEETING_PREP_INSTRUCTIONS,
  morning_brief: BRIEF_NARRATIVE_INSTRUCTIONS,
  screentime_recap: SCREENTIME_RECAP_INSTRUCTIONS,
};

/**
 * Minimal runtime for the production builders: `getService` feeds
 * `resolveOptimizedPromptForRuntime`, `character` feeds the reminder voice
 * context. `service === null` renders the inline-baseline path.
 */
function makeRuntime(service: OptimizedPromptService | null): IAgentRuntime {
  return {
    character: { name: "Eliza", bio: "A helpful personal assistant." },
    getService: (name: string) =>
      name === OPTIMIZED_PROMPT_SERVICE ? service : null,
  } as unknown as IAgentRuntime;
}

const BRIEF_SECTIONS = {
  calendar: [
    {
      id: "evt-board",
      title: "Board meeting",
      startAt: "2026-07-02T16:00:00.000Z",
      endAt: "2026-07-02T17:00:00.000Z",
    },
  ],
  inbox: [
    {
      id: "msg-1",
      channel: "email",
      senderName: "Dana",
      snippet: "Q3 budget needs your sign-off by Friday",
      urgency: "high" as const,
      classification: "needs_reply",
    },
  ],
  life: [
    {
      id: "todo-1",
      kind: "todo" as const,
      title: "Renew passport",
      dueAt: "2026-07-10T00:00:00.000Z",
    },
  ],
  money: [],
};

/** Render the task's production prompt for one fixed scenario. */
function renderScenario(task: VerifiableTask, runtime: IAgentRuntime): string {
  switch (task) {
    case "reminder_dispatch":
      return buildReminderDispatchPrompt({
        runtime,
        title: "Take blood-pressure medication",
        reminderAt: "2026-07-02T21:00:00.000Z",
        channel: "in_app",
        lifecycle: "plan",
        urgency: "high",
        recentConversation: [
          "Owner: remind me about my meds tonight",
          "Eliza: will do - 9pm reminder set.",
        ],
        nearbyReminderTitles: ["Evening walk"],
      });
    case "meeting_prep":
      return buildNarrativePrompt({
        kind: "morning",
        period: "tomorrow",
        sections: BRIEF_SECTIONS,
        runtime,
        optimizationTask: "meeting_prep",
      });
    case "morning_brief":
      return buildNarrativePrompt({
        kind: "morning",
        period: "today",
        sections: BRIEF_SECTIONS,
        runtime,
        optimizationTask: "morning_brief",
      });
    case "screentime_recap":
      return buildScreenTimeRecapRules(runtime).join("\n");
  }
}

/** Boot a service the way `start()` does: construct, then `refresh()` scan. */
async function bootServiceAt(
  storeRoot: string,
): Promise<OptimizedPromptService> {
  const service = new OptimizedPromptService();
  service.setStoreRoot(storeRoot);
  await service.refresh();
  return service;
}

// Synthetic optimized instructions per task. Each carries the task's
// load-bearing fragments (the same set `lifeops-gepa-seed` enforces before
// persisting) plus a marker the assertions key on.
const SYNTHETIC_PROMPT: Record<VerifiableTask, string> = {
  reminder_dispatch:
    "SYNTHETIC-OPTIMIZED reminder nudge policy: write one short reminder line in the owner's language.",
  meeting_prep:
    "SYNTHETIC-OPTIMIZED meeting prep: lead with agenda gaps and decision owners.",
  morning_brief:
    "SYNTHETIC-OPTIMIZED morning brief: compress the schedule into two sentences.",
  screentime_recap:
    'SYNTHETIC-OPTIMIZED screen-time recap: return {"recap":"...","topApps":[],"suggestion":"..."} JSON.',
};

function syntheticArtifact(task: VerifiableTask): OptimizedPromptArtifact {
  return {
    task,
    optimizer: "gepa",
    baseline: BASELINE_BY_TASK[task],
    prompt: SYNTHETIC_PROMPT[task],
    score: 0.9,
    baselineScore: 0.5,
    datasetId: `verify:${task}`,
    datasetSize: 1,
    generatedAt: new Date().toISOString(),
    lineage: [{ round: 0, variant: 0, score: 0.9, notes: "verify fixture" }],
  };
}

describe("optimized-prompt boot-load + production render (hermetic)", () => {
  const tempRoots: string[] = [];
  afterAll(() => {
    for (const root of tempRoots)
      rmSync(root, { recursive: true, force: true });
  });

  for (const task of VERIFIABLE_TASKS) {
    it(`${task}: persisted artifact loads at boot and changes the production prompt`, async () => {
      const root = mkdtempSync(join(tmpdir(), `opt-prompt-${task}-`));
      tempRoots.push(root);

      // Persist through the real store writer.
      const writer = new OptimizedPromptService();
      writer.setStoreRoot(root);
      await writer.setPrompt(task, syntheticArtifact(task));

      // Fresh instance = new boot. refresh() is the same scan start() runs.
      const booted = await bootServiceAt(root);
      expect(booted.hasOptimized(task)).toBe(true);
      expect(booted.getPrompt(task)?.prompt).toBe(SYNTHETIC_PROMPT[task]);

      const before = renderScenario(task, makeRuntime(null));
      const after = renderScenario(task, makeRuntime(booted));
      expect(before).toContain(BASELINE_BY_TASK[task].slice(0, 60));
      expect(after).toContain(SYNTHETIC_PROMPT[task]);
      expect(after).not.toContain(BASELINE_BY_TASK[task].slice(0, 60));
      expect(after).not.toBe(before);
    });
  }
});

const LIVE_STATE_DIR = process.env.LIFEOPS_VERIFY_STATE_DIR?.trim();

describe.runIf(Boolean(LIVE_STATE_DIR))(
  "optimized-prompt boot-load + production render (live artifacts)",
  () => {
    const onlyTask = process.env.LIFEOPS_VERIFY_TASK?.trim();
    const tasks = onlyTask
      ? VERIFIABLE_TASKS.filter((task) => task === onlyTask)
      : [...VERIFIABLE_TASKS];

    it("LIFEOPS_VERIFY_TASK, when set, names a verifiable task", () => {
      if (onlyTask) expect(tasks).toHaveLength(1);
    });

    for (const task of tasks) {
      it(`${task}: live artifact loads at boot and changes the production prompt`, async () => {
        const storeRoot = join(
          resolve(LIVE_STATE_DIR as string),
          "optimized-prompts",
        );
        const booted = await bootServiceAt(storeRoot);
        expect(
          booted.hasOptimized(task),
          `no artifact loaded for ${task} from ${storeRoot}`,
        ).toBe(true);

        const meta = booted.getMetadata(task);
        const before = renderScenario(task, makeRuntime(null));
        const after = renderScenario(task, makeRuntime(booted));

        process.stdout.write(
          `\n[verify-optimized] BOOT-LOAD OK task=${task} store=${storeRoot}\n` +
            `[verify-optimized] metadata=${JSON.stringify(meta)}\n` +
            `\n[verify-optimized] BEFORE (inline baseline):\n---\n${before}\n---\n` +
            `\n[verify-optimized] AFTER (optimized artifact):\n---\n${after}\n---\n`,
        );

        const loaded = booted.getPrompt(task);
        expect(loaded).not.toBeNull();
        expect(after).toContain((loaded as { prompt: string }).prompt);
        expect(after).not.toBe(before);
      });
    }
  },
);
