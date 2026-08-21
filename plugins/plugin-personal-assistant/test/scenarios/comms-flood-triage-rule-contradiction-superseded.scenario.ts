/**
 * D1 self-contradiction scenario. The owner states a filing rule, then corrects
 * which sender it applies to. Triage rules compose silently: keeping both the
 * mistaken rule and its correction means a whole class of mail is filtered by a
 * rule the owner already withdrew, and the owner will not see the mail that
 * proves it.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

export default scenario({
  lane: "live-only",
  id: "comms-flood-triage-rule-contradiction-superseded",
  title: "Comms flood: a corrected triage rule replaces the mistaken one",
  domain: "lifeops.inbox",
  evidenceScope: "model-behavior",
  tags: [
    "lifeops",
    "comms-flood",
    "personas",
    "self-contradiction",
    "supersession",
  ],
  tier: "T3",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Comms triage",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "dre-states-a-rule",
      room: "main",
      text: "the sales DMs are killing me. hold all of them for the 5pm digest from now on",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The owner asked for one standing rule: sales DMs are held for the 5pm digest instead of pinging. Grade PASS only if the assistant records or clearly proposes that single rule. It fails if it invents extra rules the owner did not ask for, applies the rule to every sender, or claims to have already reorganized the inbox in ways it did not.",
      },
    },
    {
      kind: "message",
      name: "dre-contradicts-the-rule",
      room: "main",
      text: "ugh no - not sales, i meant the recruiter spam. sales i actually need same-day. fix it, don't stack another rule on top",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The owner contradicted their own rule: recruiter mail is what should be held for the digest, sales must stay same-day, and they explicitly do not want two rules layered. Grade PASS only if the assistant supersedes the earlier rule — the recruiter rule survives, the sales-hold rule is withdrawn so sales flows same-day — and says plainly which rule is now in force. It fails if it leaves both rules active, adds the recruiter rule while silently keeping sales held, asks the owner to remove the old one themselves as the only resolution, or reports a change it did not make.",
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "rule-correction-no-external-send",
      predicate: expectNoExternalSendDispatch(),
    },
    {
      type: "messageDelivered",
      name: "no-outbound-from-a-rule-change",
      expected: false,
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "comms-flood-rule-supersession-end-to-end",
      minimumScore: 0.75,
      rubric:
        "End-to-end: the owner's correction replaced the mistaken sales-hold rule rather than stacking beside it — recruiter mail is digested, sales stays same-day — and the assistant stated the resulting single rule set honestly.",
    },
  ],
});
