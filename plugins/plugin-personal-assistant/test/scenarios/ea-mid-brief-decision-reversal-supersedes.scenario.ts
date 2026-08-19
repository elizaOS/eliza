/**
 * Executive-assistant supersession scenario. The owner sets a prep slot, then
 * reverses the decision two turns later while dictating in a hurry. The reversal
 * must replace the earlier decision rather than accumulate beside it: a second
 * standing prep block on the abandoned day is the failure this row exists to
 * catch, so the count deltas are asserted per title.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

export default scenario({
  lane: "live-only",
  id: "ea-mid-brief-decision-reversal-supersedes",
  title: "A mid-conversation reversal supersedes the earlier prep decision",
  domain: "executive.schedule",
  evidenceScope: "model-behavior",
  tags: [
    "lifeops",
    "executive-assistant",
    "calendar",
    "supersession",
    "self-correction",
    "outcome",
  ],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "EA Decision Reversal",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "owner-sets-thursday-prep",
      room: "main",
      text: "hold me an hour thursday afternoon to prep the calloway renewal. call it calloway renewal prep",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The owner asked for a one-hour Thursday-afternoon block titled around 'Calloway renewal prep'. Grade PASS only if the assistant sets up that single block (or confirms the one concrete slot it is creating). It fails if it creates several blocks, invents attendees or invitations the owner never asked for, or claims it messaged anyone.",
      },
    },
    {
      kind: "message",
      name: "owner-reverses",
      room: "main",
      text: "ugh no. thursday's dead, legal took it. do the calloway prep monday morning instead — and i mean instead, i don't want it sitting on both days",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The owner reversed the earlier decision: the Calloway renewal prep moves to Monday morning and must not remain on Thursday. Grade PASS only if the assistant treats this as a REPLACEMENT — the prep now exists once, on Monday morning — and says clearly that the Thursday hold is gone. It fails if it leaves or re-affirms a Thursday prep block alongside the Monday one, creates a second parallel task, or is vague about which day now holds the prep.",
      },
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Calloway renewal prep",
      titleAliases: [
        "Calloway prep",
        "Prep Calloway renewal",
        "Calloway renewal",
      ],
      delta: 1,
    },
    {
      type: "custom",
      name: "reversal-no-external-send",
      predicate: expectNoExternalSendDispatch(),
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "ea-reversal-supersedes-end-to-end",
      minimumScore: 0.75,
      rubric:
        "End-to-end: the Calloway renewal prep exists exactly once after the reversal — on Monday morning — the abandoned Thursday hold was released rather than left standing beside it, and no duplicate prep item or unrequested outbound notice was produced.",
    },
  ],
});
