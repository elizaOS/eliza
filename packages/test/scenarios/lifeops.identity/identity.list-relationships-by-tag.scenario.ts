import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "identity.list-relationships-by-tag",
  title: "List rolodex entries filtered by tag (e.g. 'family' or 'mentor')",
  domain: "lifeops.identity",
  tags: ["lifeops", "identity", "tag", "filter"],
  description:
    "User asks for everyone tagged 'family'. Three entities are tagged family, one is tagged 'mentor', one untagged. Result must include the three family entries and exclude the others.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "List by tag",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "rolodex-entity",
        displayName: "Linda (Mom)",
        tags: ["family"],
      },
    },
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "rolodex-entity",
        displayName: "Carlos (Dad)",
        tags: ["family"],
      },
    },
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "rolodex-entity",
        displayName: "Sofia (Sister)",
        tags: ["family"],
      },
    },
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "rolodex-entity",
        displayName: "Dr. Lena Park",
        tags: ["mentor"],
      },
    },
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "rolodex-entity",
        displayName: "Random Hackathon Acquaintance",
        tags: [],
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "list-family",
      room: "main",
      text: "Who's tagged family in my rolodex?",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["RELATIONSHIP"],
        description: "list by tag = family",
        includesAny: ["Linda", "Carlos", "Sofia", "family"],
      }),
      responseIncludesAny: ["Linda", "Carlos", "Sofia"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must list Linda, Carlos, and Sofia and exclude Dr. Lena Park (mentor) and the untagged acquaintance. Listing the mentor or the acquaintance fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["RELATIONSHIP"],
    },
    {
      type: "custom",
      name: "identity-list-by-tag-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["RELATIONSHIP"],
        description: "list by tag",
      }),
    },
    judgeRubric({
      name: "identity-list-by-tag-rubric",
      threshold: 0.7,
      description:
        "Family list contained Linda + Carlos + Sofia only — mentor and untagged were excluded.",
    }),
  ],
});
