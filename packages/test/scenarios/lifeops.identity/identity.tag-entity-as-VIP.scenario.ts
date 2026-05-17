import { scenario } from "@elizaos/scenario-schema";
import {
  expectMemoryWrite,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "identity.tag-entity-as-VIP",
  title: "Tag a customer entity as VIP for inbox + push triage",
  domain: "lifeops.identity",
  tags: ["lifeops", "identity", "vip", "tag"],
  description:
    "Whale customer at Acme. User tags them VIP. The tag must propagate so inbox triage promotes their threads and push escalations get tighter SLAs — confirmed in the reply.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "VIP tag",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "rolodex-entity",
        id: "ent-acme-buyer",
        displayName: "Tomás Reyes",
        company: "Acme Inc.",
        handles: [{ platform: "gmail", handle: "tomas.reyes@acme.com" }],
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "tag-vip",
      room: "main",
      text: "Tag Tomás Reyes at Acme as VIP — his threads should always be at the top of inbox triage.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["RELATIONSHIP", "LIFE"],
        description: "VIP tag with downstream triage effect",
        includesAny: ["VIP", "Tomás", "Acme", "tag", "top"],
      }),
      responseIncludesAny: ["VIP", "Tomás", "Acme", "top"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must confirm the VIP tag is applied AND describe its triage effect (inbox top, faster escalation). A bare 'tagged' without explaining the cascade fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["RELATIONSHIP", "LIFE"],
    },
    {
      type: "memoryWriteOccurred",
      table: ["messages", "facts"],
    },
    {
      type: "custom",
      name: "identity-vip-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["RELATIONSHIP", "LIFE"],
        description: "VIP tag",
      }),
    },
    {
      type: "custom",
      name: "identity-vip-persisted",
      predicate: expectMemoryWrite({
        table: ["messages", "facts"],
        description: "VIP tag persisted",
        contentIncludesAny: ["VIP", "Tomás", "Acme"],
      }),
    },
    judgeRubric({
      name: "identity-vip-rubric",
      threshold: 0.7,
      description:
        "VIP tag stored on Tomás Reyes with the triage cascade explained.",
    }),
  ],
});
