/**
 * B1 night-owl self-contradiction on the wake anchor. Noor gives a waking time,
 * then walks it back mid-thread without asking for anything to be replaced.
 * Everything in her day hangs off one wake anchor, so a second anchor left
 * standing beside the first makes every relative reminder resolve
 * nondeterministically. The correction must supersede in place; she never says
 * so, and the requirement lives only in the rubrics.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

export default scenario({
  lane: "live-only",
  id: "night-owl-corrected-wake-anchor-supersedes",
  title:
    "Night owl: a walked-back wake time replaces the anchor instead of adding one",
  domain: "lifeops.reminders",
  evidenceScope: "model-behavior",
  tags: [
    "lifeops",
    "night-owl",
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
      title: "Night owl anchor correction",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "noor-gives-a-wake-anchor",
      room: "main",
      text: "hang the morning stuff off me being up around noon, that's where i've landed lately.",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseJudge: {
        minimumScore: 0.6,
        rubric:
          "The owner has set a waking anchor around midday and asked for her morning items to hang off it. Grade PASS only if the assistant records a single waking anchor at that time and reflects it back concretely. It fails if it treats midday as a hard clock alarm she must obey, asks her to restate her whole schedule, or claims to have rescheduled things it did not.",
      },
    },
    {
      kind: "message",
      name: "noor-walks-it-back",
      room: "main",
      text: "ugh, ignore noon. it's been closer to two all week and pretending otherwise is why everything pings while i'm out cold.",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The owner has contradicted the anchor she gave a moment ago: the real waking time is nearer 14:00, and the midday figure should stop being used. Grade PASS only if the assistant revises the one existing waking anchor to the later time and confirms that the midday value is gone, so the items that hang off it follow the corrected anchor. It fails if it keeps a midday anchor alive alongside the new one, creates a second anchor or a second set of morning rules, or acknowledges the correction without actually changing what the morning items resolve against.",
      },
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "wake anchor",
      titleAliases: [
        "waking window",
        "wake time",
        "morning window",
        "wake up",
        "waking anchor",
      ],
      delta: 1,
    },
    {
      type: "custom",
      name: "anchor-correction-no-external-send",
      predicate: expectNoExternalSendDispatch(),
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "night-owl-anchor-correction-end-to-end",
      minimumScore: 0.75,
      rubric:
        "End-to-end: exactly ONE waking anchor survives and it carries the corrected later time. The assistant superseded the midday value in place rather than stacking a second anchor, and nothing it reports back still resolves against the retracted time.",
    },
  ],
});
