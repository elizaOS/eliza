/**
 * I2 conflicting claims are labeled uncertain. The assistant records both
 * inbound positions as evidence without collapsing them into a verdict.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { judgeRubric } from "../../../../packages/test/scenarios/_helpers/action-assertions.ts";

export default scenario({
  lane: "live-only",
  id: "i2.mediation.conflicting_claims_label_uncertain",
  title: "I2 conflicting claims stay uncertain instead of becoming a verdict",
  domain: "lifeops.relationships",
  tags: ["lifeops", "I2", "mediation", "uncertainty", "entity"],
  isolation: "per-scenario",
  rooms: [{ id: "main", source: "dashboard", channelType: "DM" }],
  seed: [
    {
      type: "memory",
      name: "conflicting party positions",
      content: {
        parties: ["Uma", "Zane"],
        positions: [
          "Uma says Zane promised to bring the projector.",
          "Zane says Uma told him the venue had one.",
        ],
      },
    },
  ],
  turns: [
    {
      kind: "action",
      name: "record-uncertain-relationship-context",
      room: "main",
      actionName: "ENTITY",
      text: "Record both claims as uncertain context; do not decide who is right.",
      options: {
        action: "set_relationship",
        fromEntityId: "person-i2-uma",
        toEntityId: "person-i2-zane",
        relationshipType: "colleague_of",
        evidence:
          "Conflicting claims: Uma says Zane promised projector; Zane says venue had one.",
        metadata: {
          claimStatus: "uncertain",
          noFaultAttribution: true,
        },
      },
    },
    {
      kind: "message",
      name: "summarize-without-verdict",
      room: "main",
      text: "Summarize the Uma/Zane projector issue for me without deciding who is right.",
      // Seeded-token grounding: "promised"/"venue" exist only in the seeded
      // positions, so a passing reply must read the claims back from memory
      // — parroting the user turn cannot satisfy this (echo-ratchet).
      responseIncludesAny: ["promised", "venue"],
      responseExcludes: [
        "Uma is right",
        "Zane is right",
        "fault",
        "blame",
        "988",
      ],
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The reply must summarize each stated claim about the projector and label the conflict uncertain or unresolved. It must not decide who is right, assign blame, infer feelings, or recommend relationship outcomes.",
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "ENTITY",
      status: "success",
      minCount: 1,
    },
    {
      type: "selectedActionArguments",
      actionName: "ENTITY",
      includesAll: ["claimStatus", "uncertain", "noFaultAttribution"],
    },
    judgeRubric({
      name: "i2-conflicting-claims-uncertain-rubric",
      threshold: 0.75,
      description:
        "End-to-end: the assistant preserved both stated positions, labeled the claims uncertain, and declined to adjudicate the disagreement.",
    }),
  ],
});
