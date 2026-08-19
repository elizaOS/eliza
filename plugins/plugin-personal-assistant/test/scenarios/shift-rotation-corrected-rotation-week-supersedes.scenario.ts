/**
 * B2 shift-rotation self-contradiction. Marcus states the week his nights
 * start, then corrects it mid-thread without saying "replace the old one". A
 * rotation that exists twice with two different start weeks is worse than no
 * rotation at all: every downstream anchor (sleep protection, post-shift
 * reminders) would resolve against whichever copy is read first. The correction
 * must supersede in place, and the owner never spells that requirement out.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

export default scenario({
  lane: "live-only",
  id: "shift-rotation-corrected-rotation-week-supersedes",
  title:
    "Shift rotation: a corrected rotation start supersedes the first one instead of stacking",
  domain: "lifeops.reminders",
  evidenceScope: "model-behavior",
  tags: [
    "lifeops",
    "shift-rotation",
    "personas",
    "contradiction",
    "supersession",
    "12283",
  ],
  tier: "T3",
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Shift rotation correction",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "marcus-states-rotation",
      room: "main",
      text: "put me down for nights from monday — four on, three off, clock out half seven.",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseJudge: {
        minimumScore: 0.6,
        rubric:
          "The owner has stated a night rotation starting Monday, four on and three off, clocking out at 07:30. Grade PASS only if the assistant records that rotation and reflects the pattern back concretely enough that a wrong week would be visible. It fails if it asks him to re-enter details he already gave, or claims to have notified anyone.",
      },
    },
    {
      kind: "message",
      name: "marcus-corrects-the-week",
      room: "main",
      text: "hang on, i had the wrong week in my head. it's the monday after, not this coming one. the rest of it stands.",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The owner has corrected which Monday the rotation begins while leaving the four-on/three-off pattern and 07:30 clock-out intact. Grade PASS only if the assistant revises the single existing rotation record to the later start week and confirms the corrected start, keeping the unchanged parts as they were. It fails if it creates a second rotation alongside the first, keeps the superseded start week alive anywhere, treats the correction as a brand-new unrelated schedule, or asks him to restate the pattern he explicitly said still stands.",
      },
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "night rotation",
      titleAliases: [
        "night shift",
        "shift rotation",
        "nights",
        "rotation",
        "shift pattern",
      ],
      delta: 1,
    },
    {
      type: "custom",
      name: "rotation-correction-no-external-send",
      predicate: expectNoExternalSendDispatch(),
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "shift-rotation-correction-end-to-end",
      minimumScore: 0.75,
      rubric:
        "End-to-end: exactly ONE rotation record survives and it carries the corrected later start week with the original four-on/three-off pattern and 07:30 clock-out. The assistant superseded in place rather than layering a second conflicting rotation, and no stale start week remains anywhere in what it reports back.",
    },
  ],
});
