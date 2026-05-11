import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "identity.detect-likely-rename",
  title: "Flag a likely Telegram handle rename for user confirmation",
  domain: "lifeops.identity",
  tags: ["lifeops", "identity", "rename", "detection"],
  description:
    "A Telegram contact changed handle from @oldhandle → @newhandle but the same user_id keeps appearing in messages. Agent must propose linking, not auto-merge silently nor lose the history.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Detect rename",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "rolodex-entity",
        platform: "telegram",
        oldHandle: "@oldhandle",
        newHandle: "@newhandle",
        platformUserId: "tg-12345",
        displayName: "Casey Liu",
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "review-rename",
      room: "main",
      text: "I think Casey changed Telegram handle from @oldhandle to @newhandle. Same user-id. What do you suggest?",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["RELATIONSHIP", "LIFE"],
        description: "likely-rename detection + confirm",
        includesAny: ["rename", "@oldhandle", "@newhandle", "Casey", "confirm"],
      }),
      responseIncludesAny: ["@oldhandle", "@newhandle", "Casey", "confirm"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must propose linking @oldhandle → @newhandle under Casey, ask for explicit confirmation, and surface the platform_user_id match as evidence. Silently merging without asking fails. Splitting them into two entities also fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["RELATIONSHIP", "LIFE"],
    },
    {
      type: "custom",
      name: "identity-rename-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["RELATIONSHIP", "LIFE"],
        description: "likely-rename surface for user confirm",
      }),
    },
    judgeRubric({
      name: "identity-rename-rubric",
      threshold: 0.7,
      description:
        "Rename surfaced with evidence (user_id), gated on user confirmation.",
    }),
  ],
});
