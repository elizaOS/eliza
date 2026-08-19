/**
 * B1 night-owl-anchored-day (live). noor_night first states her sleep window,
 * then contradicts it a beat later ("actually I've been sleeping earlier this
 * week, don't assume 11:30 anymore"). The assistant must UPDATE the single
 * quiet-hours/anchor rule in place, not layer a second conflicting rule on top.
 * Exercises contradiction reconciliation on the personas pack (#12283); maps to
 * LifeOpsBench live.nightowl.contradiction_reconciles_anchor.
 *
 * Personas-as-data: the correction lives in the turn text, never in
 * `promptInstructions` (root AGENTS.md — one scheduler, structural fields only).
 *
 * OUTCOME (not echo): definitionCountDelta{delta:1} on the quiet-hours rule
 * proves the correction converged to ONE rule (an update, not a second layered
 * definition), and the judge grades that the old 11:30 assumption was replaced
 * rather than duplicated. Asserted concepts are derived from the response.
 *
 * Live-verify note (#12781): whether the update mutates the existing definition
 * or replaces it is confirmed at live capture; the load-bearing outcome (exactly
 * one surviving quiet-hours rule, not two conflicting ones) does not depend on it.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "night-owl-contradiction-reconciles-anchor",
  title:
    "Night owl: 'sleeping earlier now' updates the one rule, does not layer a second",
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
      name: "noor states her quiet-hours window",
      text: "keep my quiet hours from when i crash to when i'm up — i've been going down around 4 and surfacing near 11:30.",
    },
    {
      kind: "message",
      name: "noor contradicts it a beat later",
      text: "actually scratch part of that. i've been crashing earlier this week, more like 2. don't keep assuming 11:30 either. update the one rule, don't stack another one on top of it.",
      responseJudge: {
        minimumScore: 0.6,
        rubric:
          "The owner first gave a quiet-hours window, then corrected it (crashing earlier, ~2, and stop assuming 11:30), explicitly asking to UPDATE the single existing rule and NOT stack a second one. Grade PASS only if the assistant revised the one quiet-hours/anchor rule in place to the new timing and confirmed the correction, without creating a second conflicting rule. Deduct heavily if it layered an additional quiet-hours definition or kept the stale 11:30 assumption alongside the new one.",
      },
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "quiet hours",
      titleAliases: [
        "quiet hours window",
        "sleep window",
        "do not disturb",
        "quiet window",
      ],
      delta: 1,
    },
    {
      type: "judgeRubric",
      name: "single-rule-updated-not-layered",
      minimumScore: 0.6,
      rubric:
        "End-to-end: after the contradiction, exactly ONE quiet-hours/sleep rule remains and it reflects the corrected earlier-crash timing — the assistant updated in place rather than adding a second conflicting rule, and dropped the stale 11:30 assumption. Grade PASS only if there is a single reconciled rule. Deduct heavily for two coexisting rules or a retained 11:30.",
    },
  ],
});
