/**
 * Child-voice school deadline scenario: a twelve-year-old owner gives a messy
 * report deadline, gets distracted, then confirms. The outcome bar is a real
 * stored reminder plan for the report, not a friendly echo of the ask.
 *
 * The explicit confirmation turn is load-bearing: the pack's consent bar
 * (two-phase commit — preview an owner write, save only after a yes) means
 * "save the reminder plan please" for a multi-part derived plan correctly
 * yields an unsaved preview (the child has not yet seen the derived
 * title/timing), so the stored-outcome final checks can only be satisfied
 * after the child says yes to the preview.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "child-book-report-backplan",
  title: "Child voice: book-report deadline becomes a back-planned reminder",
  domain: "lifeops.reminders",
  evidenceScope: "model-behavior",
  tags: ["lifeops", "mvp", "child-voice", "student-deadline", "14352"],
  tier: "T2",
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "imessage",
      channelType: "DM",
      title: "Child book report",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "messy child deadline ask",
      text: "um hi i'm 12 and i have a book report friday and i have not started and i keep forgetting. can you help me not mess it up? i need to read 3 chapters and make the poster thing.",
      responseJudge: {
        name: "preview-before-saving-child-deadline",
        minimumScore: 0.6,
        rubric:
          "Grade PASS only if the assistant treats the speaker as the owner, uses plain practical language, proposes a concrete report plan/reminder setup, and asks for confirmation before claiming it is saved. Fail if it uses therapy/crisis language, talks to a parent instead of the child, or says the reminder is already saved before confirmation.",
      },
    },
    {
      kind: "message",
      name: "distractor before consent",
      text: "wait also what if i make the poster blue? actually don't answer that, save the reminder plan please.",
    },
    {
      kind: "message",
      name: "child confirms the previewed plan",
      text: "yes lock it in! and can it bug me before friday too so i actually read the chapters, not just friday morning.",
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "book report",
      titleAliases: [
        "book report",
        "report friday",
        "finish book report",
        "book report poster",
      ],
      delta: 1,
      requireReminderPlan: true,
    },
    {
      type: "judgeRubric",
      name: "child-book-report-derived-plan",
      minimumScore: 0.7,
      rubric:
        "The child said the report is due Friday and gave component work (read 3 chapters, make poster). Grade PASS only if the final assistant behavior created a practical reminder/deadline plan for the report with at least one derived preparation step or earlier checkpoint, not merely a single echo of 'book report Friday'. Fail for therapy language, parent-only framing, or no stored reminder outcome.",
    },
  ],
});
