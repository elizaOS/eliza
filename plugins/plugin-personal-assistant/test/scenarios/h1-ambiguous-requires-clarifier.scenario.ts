/**
 * H1 ambiguity guard. When message-history signals do not justify a confident
 * relationship type, the assistant must ask the owner instead of writing a low
 * confidence edge.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { judgeRubric } from "../../../../packages/test/scenarios/_helpers/action-assertions.ts";

export default scenario({
  lane: "live-only",
  id: "h1-ambiguous-requires-clarifier",
  title: "H1 ambiguous relationship signal asks instead of asserting",
  domain: "lifeops.relationships",
  tags: ["lifeops", "H1", "relationships", "uncertainty", "no-fabrication"],
  isolation: "per-scenario",
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "H1 Ambiguous Relationship",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ambiguous relationship type",
      room: "main",
      text: "I have a few mixed messages with Avery: some work logistics, some weekend jokes. Infer the relationship type if you can.",
      responseIncludesAny: ["not enough", "clarify", "ask", "confirm"],
      responseExcludes: ["saved", "recorded", "definitely", "must be"],
      responseJudge: {
        minimumScore: 0.8,
        rubric:
          "The reply must treat the relationship type as ambiguous and ask the owner to confirm before saving an edge. It fails if it asserts a confident friend/colleague/partner/family edge from mixed evidence.",
      },
    },
  ],
  finalChecks: [
    judgeRubric({
      name: "h1-ambiguous-relationship-clarifier-rubric",
      threshold: 0.8,
      description:
        "End-to-end: ambiguous relationship-history signals caused a clarifying question, not a fabricated or low-confidence relationship edge.",
    }),
  ],
});
