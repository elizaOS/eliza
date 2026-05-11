import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "identity.search-across-handles",
  title: "Search the rolodex returns the same entity for any handle on any platform",
  domain: "lifeops.identity",
  tags: ["lifeops", "identity", "search", "merge"],
  description:
    "An entity has gmail + telegram + discord handles. Searching by any one of the three must resolve to the same entity. Catches a regression where the search index forgot to include some handles after merge.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Search across handles",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "rolodex-entity",
        id: "ent-priya-mehta",
        displayName: "Priya Mehta",
        handles: [
          { platform: "gmail", handle: "priya.mehta@vela.studio" },
          { platform: "telegram", handle: "@priyam" },
          { platform: "discord", handle: "priyam#0042" },
        ],
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "search-by-telegram",
      room: "main",
      text: "Who is @priyam on Telegram? Pull up everything we have on them.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["RELATIONSHIP"],
        description: "search by handle resolves to merged entity",
        includesAny: ["Priya", "@priyam", "priya.mehta", "gmail", "discord"],
      }),
      responseIncludesAny: ["Priya", "@priyam", "priya.mehta", "discord"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must surface Priya Mehta with all three handles (gmail + telegram + discord) — not just the telegram handle that was searched. A reply that only returns the queried handle fails.",
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
      name: "identity-search-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["RELATIONSHIP"],
        description: "search across handles",
      }),
    },
    judgeRubric({
      name: "identity-search-rubric",
      threshold: 0.7,
      description:
        "Search by one handle returned the merged entity with all three handles.",
    }),
  ],
});
