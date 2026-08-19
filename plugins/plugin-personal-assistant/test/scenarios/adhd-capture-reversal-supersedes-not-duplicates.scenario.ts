/**
 * A1 adhd-capture-and-start (live). Casey commits to a Saturday errand, then
 * reverses it two turns later once the real constraint surfaces. Unlike the
 * in-message "wait no" correction, the reversal arrives after the capture has
 * already landed, so the assistant has to supersede an existing item rather
 * than treat the second ask as a new commitment. Leaving both is the failure
 * mode this row exists to catch: for an ADHD owner, a stale duplicate reminder
 * is worse than none, because it teaches them to ignore the whole channel.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "adhd-capture-reversal-supersedes-not-duplicates",
  title:
    "ADHD: a later reversal supersedes the captured plan, not duplicates it",
  domain: "lifeops.reminders",
  evidenceScope: "model-behavior",
  tags: [
    "lifeops",
    "adhd",
    "personas",
    "supersession",
    "contradiction",
    "12283",
  ],
  tier: "T2",
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "ADHD capture",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "casey-commits-to-saturday",
      room: "main",
      text: "remind me saturday morning to drop the donation bags at the shelter, they've been in the hallway for three weeks and i'm losing it.",
      responseJudge: {
        minimumScore: 0.6,
        rubric:
          "Casey asked for a Saturday-morning reminder to drop donation bags at the shelter. Grade PASS only if the assistant captures that as a single dated reminder without inventing extra tasks about the hallway or the three weeks, and without moralizing about the delay.",
      },
    },
    {
      kind: "message",
      name: "casey-reverses-after-a-constraint-surfaces",
      room: "main",
      text: "hm actually the shelter's closed weekends, i forgot. it has to be thursday after work instead.",
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "Casey has reversed the timing she gave a moment ago: the donation drop must move from Saturday morning to Thursday after work. Grade PASS only if the assistant treats this as a REPLACEMENT of the reminder it just captured — one donation-drop reminder now on Thursday — and says so plainly. It fails if it leaves the Saturday reminder standing alongside a new Thursday one, if it describes two separate donation tasks, or if it asks Casey to go delete the old one herself.",
      },
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "donation",
      titleAliases: [
        "drop donation bags",
        "donation bags shelter",
        "donation drop off",
        "drop off donations",
        "take donations to shelter",
      ],
      delta: 1,
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "adhd-reversal-supersedes-end-to-end",
      minimumScore: 0.75,
      rubric:
        "End-to-end: the Saturday donation-drop commitment Casey made and then reversed ended up as exactly ONE reminder on Thursday after work. The assistant superseded its own earlier capture instead of stacking a second reminder, and it did not push the cleanup back onto Casey.",
    },
  ],
});
