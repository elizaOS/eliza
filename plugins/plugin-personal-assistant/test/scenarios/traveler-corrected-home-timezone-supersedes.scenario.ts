/**
 * C1 traveler self-contradiction on the reference zone. Elena tells the
 * assistant which zone to treat as hers, then corrects it a beat later without
 * asking for a replacement. Two live reference zones is the worst possible
 * outcome — worse than the wrong one — because every subsequent bare time
 * resolves against whichever is read first. The correction must supersede in
 * place, and she never spells that out.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

export default scenario({
  lane: "live-only",
  id: "traveler-corrected-home-timezone-supersedes",
  title:
    "Traveler: a corrected reference timezone replaces the first, never coexists with it",
  domain: "lifeops.reminders",
  evidenceScope: "model-behavior",
  tags: [
    "lifeops",
    "traveler",
    "personas",
    "contradiction",
    "supersession",
    "timezone",
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
      title: "Traveler zone correction",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "elena-sets-a-reference-zone",
      room: "main",
      text: "for this stretch just treat lisbon as my clock, everything i say is that unless i flag it.",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseJudge: {
        minimumScore: 0.6,
        rubric:
          "The owner has set a single reference timezone that bare times should resolve against for this stretch of travel. Grade PASS only if the assistant records that one reference zone and confirms it plainly. It fails if it asks her to restate her whole itinerary, or claims to have rewritten existing items it has not touched.",
      },
    },
    {
      kind: "message",
      name: "elena-corrects-the-zone",
      room: "main",
      text: "no wait, lisbon's next week. i'm still an hour behind that this week - use where i actually am, and don't leave the other one hanging around.",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The owner has corrected her reference zone: the one she named belongs to next week, and this week she is an hour behind it. Grade PASS only if the assistant replaces the single reference zone with the corrected one, confirms which zone bare times now resolve against, and makes clear the earlier zone is no longer in force. It fails if it keeps both zones alive, records a second reference rule alongside the first, silently keeps applying the retracted zone, or re-resolves times against a zone it never confirmed with her.",
      },
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "reference timezone",
      titleAliases: [
        "home timezone",
        "timezone",
        "default timezone",
        "current timezone",
        "working timezone",
      ],
      delta: 1,
    },
    {
      type: "custom",
      name: "zone-correction-no-external-send",
      predicate: expectNoExternalSendDispatch(),
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "traveler-zone-correction-end-to-end",
      minimumScore: 0.75,
      rubric:
        "End-to-end: exactly ONE reference timezone survives and it is the corrected one. The assistant superseded the retracted zone in place rather than layering a second rule, and nothing it reports back still resolves against the zone she withdrew.",
    },
  ],
});
