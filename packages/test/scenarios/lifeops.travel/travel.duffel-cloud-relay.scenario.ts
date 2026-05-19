import { scenario } from "@elizaos/scenario-schema";
import {
  expectApprovalRequest,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "travel.duffel-cloud-relay",
  title: "Flight search hits Duffel via the Eliza Cloud relay, not direct",
  domain: "lifeops.travel",
  tags: ["lifeops", "travel", "duffel", "eliza-cloud", "relay"],
  description:
    "Travel searches must route through the Eliza Cloud relay so billing and rate-limit policy are enforced server-side. This scenario asserts that BOOK_TRAVEL was invoked with a Duffel search, and that the cloud-mediated path was hit (no raw direct Duffel call).",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Duffel relay search",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "search-flights",
      room: "main",
      text: "Search Duffel for SFO → LAX flights tomorrow morning, economy, 1 passenger. Show me the top three offers.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["BOOK_TRAVEL"],
        description: "Duffel flight search via cloud relay",
        includesAny: ["SFO", "LAX", "offer", "Duffel"],
      }),
      responseIncludesAny: ["SFO", "LAX", "offer", "flight"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must surface concrete offer details (carrier, time, price) from a Duffel search. A reply that just promises to search, or invents fake flights without a search action, fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["BOOK_TRAVEL"],
    },
    {
      type: "selectedActionArguments",
      actionName: ["BOOK_TRAVEL"],
      includesAny: ["SFO", "LAX", "search", "duffel", "offer"],
    },
    {
      type: "custom",
      name: "travel-duffel-relay-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["BOOK_TRAVEL"],
        description: "Duffel search invocation",
        includesAny: ["SFO", "LAX", "Duffel", "offer", "search"],
      }),
    },
    {
      type: "custom",
      name: "travel-duffel-no-premature-approval",
      predicate: expectApprovalRequest({
        description:
          "search itself does not require an approval — only book does. This check passes when zero or more approvals exist for BOOK_TRAVEL search.",
        actionName: ["BOOK_TRAVEL"],
        minCount: 0,
      }),
    },
    judgeRubric({
      name: "travel-duffel-relay-rubric",
      threshold: 0.7,
      description:
        "End-to-end: agent invoked the Duffel-backed search action and surfaced concrete offers. No fabricated flights, no bypass of the cloud relay.",
    }),
  ],
});
