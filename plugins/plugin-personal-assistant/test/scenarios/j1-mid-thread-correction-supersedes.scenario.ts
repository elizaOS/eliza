/**
 * Co-parenting supersession scenario. The owner sets up a handoff-prep
 * reminder, then contradicts themselves two turns later: the swap moved the
 * handoff to Saturday morning. The corrected day must SUPERSEDE the original
 * reminder — the deterministic gate is the definition count (net one matching
 * reminder, a duplicate makes it two), while the judge grades whether the
 * surviving reminder reflects the correction.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

export default scenario({
  lane: "live-only",
  id: "j1-mid-thread-correction-supersedes",
  title: "A mid-thread handoff correction supersedes instead of duplicating",
  domain: "lifeops.coparenting",
  evidenceScope: "model-behavior",
  tags: ["lifeops", "coparenting", "supersession", "reminders", "mvp", "14789"],
  tier: "T2",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "J1 Correction Supersedes",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "initial-friday-prep-reminder",
      room: "main",
      text: "sam and i worked out a swap for this week. remind me thursday evening to pack Mira's overnight bag for the friday handoff.",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The owner asked for a Thursday-evening reminder to pack Mira's overnight bag ahead of a Friday handoff. Grade PASS only if the assistant captures that reminder (or clearly confirms it will). It fails if it drafts or sends anything to the co-parent or turns a simple reminder request into relationship commentary.",
      },
    },
    {
      kind: "message",
      name: "owner-contradicts-earlier-day",
      room: "main",
      text: "ugh wait, i had it backwards. the swap means the handoff is saturday morning now, not friday. fix it so i'm not getting pinged about the wrong day.",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The owner corrected themselves: the handoff moved from Friday to Saturday morning. Grade PASS only if the assistant updates or replaces the existing packing reminder so exactly one reminder remains, aligned to the Saturday-morning handoff. It fails if it keeps the Friday version alongside a new one, creates a second overlapping reminder, or scolds the owner for the mix-up.",
      },
    },
  ],
  finalChecks: [
    {
      // Net exactly one matching reminder across both turns: a duplicate
      // (Friday original kept next to a Saturday replacement) yields two and
      // fails this deterministic count.
      type: "definitionCountDelta",
      title: "pack Mira's overnight bag",
      titleAliases: [
        "pack Mira",
        "Mira overnight bag",
        "overnight bag",
        "handoff bag",
      ],
      delta: 1,
    },
    {
      type: "custom",
      name: "correction-no-external-send",
      predicate: expectNoExternalSendDispatch(),
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "j1-correction-supersedes-end-to-end",
      minimumScore: 0.75,
      rubric:
        "End-to-end: the owner's Saturday correction superseded the Friday packing reminder rather than adding a duplicate — one reminder survives, tied to the corrected handoff day, and nothing was sent to the co-parent.",
    },
  ],
});
