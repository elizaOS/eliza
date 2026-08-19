/**
 * Onboarding journey — abandon mid-customize, then resume without data loss.
 * The owner answers the first two customize questions, walks away, and comes
 * back later. The LIVE message turns show the interruption + return (recorded
 * trajectory evidence); pass/fail is the DOMAIN durability contract, since
 * first-run is conductor-driven, not model-invocable. The final check proves it:
 * a fresh `FirstRunService` instance reads the persisted `partialAnswers` and
 * resumes at the first UNanswered question (categories) instead of re-asking the
 * name or windows, and the flow still reaches a real seeded first reminder
 * anchored to the earlier answer.
 *
 * Fail-without-fix anchor: `FirstRunStateStore.recordAnswer` / `.abandon`
 * persistence (`src/lifeops/first-run/state.ts`) and the resume merge in
 * `FirstRunService.runCustomizePath` (`persistCustomizePartials` +
 * `nextCustomizeQuestion`).
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  abandonResumeNoDataLoss,
  resetFirstRunPrecondition,
} from "./_helpers/first-run-onboarding.ts";

export default scenario({
  lane: "live-only",
  id: "first-run-abandon-resume-no-data-loss",
  title: "First-run resume: abandon mid-customize → resume with no re-asking",
  domain: "lifeops.first-run",
  evidenceScope: "model-behavior",
  tags: ["lifeops", "first-run", "onboarding", "resume", "mvp", "14353"],
  status: "active",
  tier: "T3",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "First open (interrupted)",
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
      name: "owner starts customize then gets pulled away",
      text: "let's customize. call me Riley, i'm in America/Chicago, mornings 7 to noon. actually hold on, someone's at the door — brb.",
      responseJudge: {
        name: "abandon-midflow-graceful-pause",
        minimumScore: 0.6,
        rubric:
          "A fresh owner started customizing their setup (name Riley, America/Chicago, mornings 7-noon) and then broke off mid-flow ('someone's at the door — brb'). Grade PASS only if the assistant handles the interruption gracefully in plain words: it acknowledges the pause and/or the answers given so far, and does not pressure the owner, discard their answers, or claim the whole setup finished. Fail if it ignores the interruption, mangles the given answers (wrong name/timezone), or leaks internal jargon (task ids, cron/ISO formats).",
      },
    },
    {
      kind: "message",
      name: "owner returns to finish",
      text: "ok i'm back — where were we? let's keep going with the setup.",
      responseJudge: {
        name: "resume-picks-up-without-reasking",
        minimumScore: 0.6,
        rubric:
          "The owner returned after abandoning setup mid-customize; their earlier answers (name Riley, America/Chicago, mornings 7-noon) were already given. Grade PASS only if the assistant resumes the setup conversation coherently — continuing from where they left off or summarizing what it already has before moving on. Fail if it restarts from scratch by re-asking the name or timezone as if never answered, denies any setup was in progress, or leaks internal jargon.",
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "resume-preserves-answers-no-reask",
      predicate: abandonResumeNoDataLoss,
    },
  ],
});
