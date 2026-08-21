/**
 * Onboarding journey — fast-start (defaults) path. A fresh owner asks to be set
 * up quickly. The message turns run against the LIVE model with the
 * `firstRunProvider` affordance surfaced (the seed restores fresh `pending`
 * state), so the recorded trajectory shows the live model engaging with
 * onboarding — the "walk the user through" evidence.
 *
 * Pass/fail is the DOMAIN outcome, not chat text: first-run is conductor-driven,
 * not model-invocable (no planner action seeds it), so the model's improvised
 * reply is not the asserted contract. The final check drives the real
 * `FirstRunService` through the production runner (the seam the in-chat
 * conductor uses) and asserts `app_lifeops.life_scheduled_tasks` via
 * `LifeOpsRepository`: the default pack (gm/gn/checkin/morning-brief)
 * materializes and the gm reminder's cron is anchored to the answered wake time.
 *
 * Fail-without-fix anchor: `FirstRunService.runDefaultsPath` + `buildDefaultsPack`
 * (`src/lifeops/first-run/defaults.ts`).
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  fastStartSeedsFirstReminder,
  resetFirstRunPrecondition,
} from "./_helpers/first-run-onboarding.ts";

export default scenario({
  lane: "live-only",
  id: "first-run-fast-start-seeds-first-reminder",
  title: "First-run fast-start: defaults + wake time → first reminder seeded",
  domain: "lifeops.first-run",
  evidenceScope: "model-behavior",
  tags: ["lifeops", "first-run", "onboarding", "mvp", "14353"],
  status: "active",
  tier: "T2",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "First open",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "reset first-run to fresh pending",
      apply: resetFirstRunPrecondition,
    },
  ],
  turns: [
    {
      kind: "message",
      name: "owner asks to be set up fast",
      text: "hey — just installed you. can you get me set up? i don't want to fiddle with a bunch of settings, just the sensible defaults.",
      responseJudge: {
        name: "fast-start-engages-onboarding",
        minimumScore: 0.6,
        rubric:
          "A fresh owner asked to be set up with sensible defaults; the assistant has a pending first-run affordance. Grade PASS only if the assistant engages with getting the owner set up (accepts the defaults choice and/or asks a needed setup question such as wake time) in plain words. Fail if it denies having a setup flow, claims the entire setup is already finished before asking anything, or dumps internal jargon (task ids, cron/ISO formats).",
      },
    },
    {
      kind: "message",
      name: "owner answers wake time",
      text: "i usually wake up around 6:30am",
      responseJudge: {
        name: "fast-start-wake-answer-plain-ack",
        minimumScore: 0.6,
        rubric:
          "The owner just answered a setup question with their wake time (around 6:30am). Grade PASS only if the assistant acknowledges the 6:30am answer and continues the setup conversation coherently in plain words. Fail if it ignores the wake time, contradicts it, or leaks internal jargon (task ids, cron expressions, ISO timestamps) into the reply.",
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "defaults-pack-seeded-anchored-to-wake",
      predicate: fastStartSeedsFirstReminder("6:30am"),
    },
  ],
});
