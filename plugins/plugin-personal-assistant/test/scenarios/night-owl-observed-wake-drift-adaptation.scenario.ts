/**
 * B1 night-owl-anchored-day (live). noor_night reports her observed wake time
 * drifting later across the week (12:10 → 12:45 → 1:05). The assistant must
 * treat these as observations that UPDATE her wake anchor estimate, not keep
 * acting on a stale 11:30 assumption — and must not moralize about the later
 * hours. Exercises longitudinal anchor adaptation on the personas pack (#12283);
 * maps to LifeOpsBench live.nightowl.observed_wake_drift_adaptation.
 *
 * Personas-as-data: the drift framing lives in the turn text, never in
 * `promptInstructions` (root AGENTS.md — one scheduler, structural fields only).
 *
 * OUTCOME (not echo): the judge grades the load-bearing behavior — the anchor
 * baseline moves with the observations and the stale 11:30 is dropped — while
 * definitionCountDelta{delta:0} on a fixed-11:30 reminder proves the assistant
 * did NOT paper over the drift by minting a new hardcoded-time definition. The
 * asserted concepts are derived from the response, not copied from the turn text.
 *
 * Live-verify note (#12781): whether the update lands as an OwnerFact wake-anchor
 * revision or a reworded single definition is confirmed at live capture; the
 * load-bearing negative (no new fixed-11:30 definition) does not depend on that.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "night-owl-observed-wake-drift-adaptation",
  title: "Night owl: observed wake drift updates the anchor, not a stale 11:30",
  domain: "lifeops.reminders",
  evidenceScope: "model-behavior",
  tags: ["lifeops", "night-owl", "personas", "12283"],
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Night owl day",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "noor reports her wake times drifting later",
      text: "heads up, my wake time's been sliding. i got up 12:10 monday, 12:45 yesterday, 1:05 today. stop acting like i'm still an 11:30 person — track where it's actually landing.",
      responseJudge: {
        minimumScore: 0.6,
        rubric:
          "The owner (night owl) reports her observed wake time drifting later across three days and asks the assistant to track the real trend, not a stale 11:30 baseline. Grade PASS only if the assistant treats the reported times as observations that update her wake-anchor estimate (acknowledging the shift toward a later baseline) rather than continuing to assume 11:30. It must NOT judge or comment negatively on the later wake times. Deduct heavily if it keeps the old 11:30 estimate unchanged or lectures her about sleeping in.",
      },
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "wake at 11:30",
      titleAliases: [
        "11:30 wake",
        "wake up 11:30",
        "morning at 11:30",
        "fixed wake time",
      ],
      delta: 0,
    },
    {
      type: "judgeRubric",
      name: "anchor-tracks-drift-drops-stale-baseline",
      minimumScore: 0.6,
      rubric:
        "The assistant updated its model of the owner's wake time to follow the reported later drift and explicitly stopped relying on the old 11:30 assumption, without layering a brand-new fixed-time rule and without any judgment about the later hours. Grade PASS only if the stale baseline was abandoned in favor of the observed trend. Deduct heavily for retaining 11:30, creating a new hardcoded wake time, or moralizing.",
    },
  ],
});
