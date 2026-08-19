/**
 * Child-voice routine scenario. The child asks in ordinary words, so the
 * assistant should materialize a simple morning routine without adding parent
 * rails, shame, or clinical framing.
 *
 * The explicit confirmation turn is load-bearing: the pack's consent bar
 * (two-phase commit — preview an owner write, save only after a yes) means the
 * first ask correctly yields an unsaved draft, so the stored-outcome final
 * checks can only be satisfied after the child says yes.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "child-morning-routine-plain-words",
  title: "Child voice: plain morning routine becomes a daily reminder",
  domain: "lifeops.reminders",
  evidenceScope: "model-behavior",
  tags: ["lifeops", "mvp", "child-voice", "routine", "14352"],
  tier: "T1",
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Child morning routine",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "plain routine ask",
      text: "before school i always forget stuff. can you remind me every morning to brush teeth, pack my lunch, and put my math folder in my bag? just say it normal, not like a baby.",
    },
    {
      kind: "message",
      name: "confirm the routine",
      text: "yes turn it on please. normal words like that is good.",
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "school morning",
      titleAliases: [
        "school morning",
        "brush teeth",
        "pack lunch",
        "math folder",
        "morning routine",
        // Live models legitimately title this "Before-school checklist" /
        // "School checklist"; a bare "checklist" alias would also loose-match
        // the simulator's seeded "…launch checklist" row, so keep these
        // school-anchored.
        "before school",
        "school checklist",
      ],
      delta: 1,
      cadenceKind: "daily",
      requireReminderPlan: true,
    },
    {
      type: "judgeRubric",
      name: "plain-child-routine-no-therapy",
      minimumScore: 0.7,
      rubric:
        "Grade PASS only if the assistant creates a straightforward daily school-morning reminder/routine covering teeth, lunch, and math folder in plain age-respectful wording. Fail for therapy language, parent-only handoff, infantilizing tone, or missing stored routine/reminder outcome.",
    },
  ],
});
