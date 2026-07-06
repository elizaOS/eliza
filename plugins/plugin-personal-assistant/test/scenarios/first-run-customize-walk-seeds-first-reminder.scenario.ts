/**
 * Onboarding journey — customize (5-question) path. A fresh owner opts to
 * customize; the LIVE message turns exercise the model with the onboarding
 * affordance surfaced (recorded trajectory = the "walk the user through"
 * evidence), while the final check drives the real `FirstRunService` through all
 * five questions, including the CONDITIONAL relationships question that fires
 * only because `follow-ups` is among the selected categories.
 *
 * Pass/fail is the DOMAIN outcome, not chat text (first-run is conductor-driven,
 * not model-invocable): the final check asserts the seeded default pack in the
 * real scheduled-task store, anchored to the answered morning window, via
 * `LifeOpsRepository`.
 *
 * Fail-without-fix anchor: `FirstRunService.runCustomizePath` +
 * `nextCustomizeQuestion` conditional gating (`src/lifeops/first-run/service.ts`)
 * and the `relationships.shouldAsk` predicate (`.../first-run/questions.ts`).
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  customizeFullWalkSeedsReminders,
  resetFirstRunPrecondition,
} from "./_helpers/first-run-onboarding.ts";

export default scenario({
  lane: "live-only",
  id: "first-run-customize-walk-seeds-first-reminder",
  title: "First-run customize: full 5-question walk → first reminder seeded",
  domain: "lifeops.first-run",
  tags: ["lifeops", "first-run", "onboarding", "customize", "mvp", "14353"],
  status: "active",
  tier: "T2",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "First open (customize)",
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
      name: "owner chooses to customize",
      text: "i'd rather customize my setup than take the defaults — walk me through the options.",
    },
    {
      kind: "message",
      name: "owner supplies preferences incl. follow-ups",
      text: "call me Sam. i'm in America/Los_Angeles, morning is roughly 6:30 to 11:30, evening 6 to 10pm. turn on reminder packs and follow-ups. nudge me in-app. for follow-ups: Alice every 2 weeks, Bob monthly.",
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "customize-walk-conditional-q5-and-seeded-pack",
      predicate: customizeFullWalkSeedsReminders,
    },
  ],
});
