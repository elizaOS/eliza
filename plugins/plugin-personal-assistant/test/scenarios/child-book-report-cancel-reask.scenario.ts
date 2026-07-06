/**
 * Child-voice cancellation repair scenario. A child cancels the first proposed
 * report reminder, then re-asks with a narrower version; the assistant should
 * respect the cancellation and store only the confirmed replacement.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "child-book-report-cancel-reask",
  title: "Child voice: cancelled book-report reminder is not duplicated",
  domain: "lifeops.reminders",
  tags: ["lifeops", "mvp", "child-voice", "student-deadline", "14352"],
  tier: "T2",
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "telegram",
      channelType: "DM",
      title: "Child cancel and re-ask",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "first report reminder ask",
      text: "can you remind me about my science report? it's due next monday and i think i should start this weekend.",
    },
    {
      kind: "message",
      name: "cancel the first attempt",
      text: "actually no wait don't save that one. my teacher changed it and i need to ask her tomorrow first.",
      responseJudge: {
        name: "cancel-respected-before-reask",
        minimumScore: 0.6,
        rubric:
          "Grade PASS only if the assistant acknowledges the cancellation and does not claim the science-report reminder is saved. It may offer to help later. Fail if it keeps or confirms the canceled reminder.",
      },
    },
    {
      kind: "message",
      name: "replacement confirmed ask",
      text: "ok now save just this: tomorrow after school remind me to ask Ms. Rivera what the science report topic is.",
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "ask Ms. Rivera",
      titleAliases: [
        "ask Ms. Rivera",
        "ask teacher",
        "science report topic",
        "ask what the science report topic is",
      ],
      delta: 1,
      requireReminderPlan: true,
    },
    {
      type: "definitionCountDelta",
      title: "science report due next monday",
      titleAliases: ["science report due", "start science report"],
      delta: 0,
    },
  ],
});
