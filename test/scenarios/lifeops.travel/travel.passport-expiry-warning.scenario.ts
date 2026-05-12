import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();

export default scenario({
  id: "travel.passport-expiry-warning",
  title: "Warn when passport expiry is inside the international trip's 6-month rule",
  domain: "lifeops.travel",
  tags: ["lifeops", "travel", "passport", "compliance"],
  description:
    "Many countries require ≥6 months passport validity from entry date. When booking an international trip whose entry date is within that window, the agent must warn the user — NOT silently book and let them get stuck at the airport.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Passport expiry warning",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "profile",
        passport: {
          country: "US",
          number: "X1234567",
          expiresAt: new Date(now + 150 * DAY_MS).toISOString(),
        },
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "international-booking",
      room: "main",
      text: "Book me round trip SFO → CDG in 90 days, returning 100 days out. Use my passport on file.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["BOOK_TRAVEL", "PROFILE"],
        description: "passport expiry rule check",
        includesAny: ["passport", "expire", "6 months", "valid"],
      }),
      responseIncludesAny: ["passport", "expire", "valid", "renew"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must warn that passport validity is inside the 6-month rule for France/Schengen and either block the booking or surface the risk explicitly. Silently booking fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["BOOK_TRAVEL", "PROFILE"],
    },
    {
      type: "custom",
      name: "travel-passport-expiry-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["BOOK_TRAVEL", "PROFILE"],
        description: "passport expiry rule check",
      }),
    },
    judgeRubric({
      name: "travel-passport-expiry-rubric",
      threshold: 0.7,
      description:
        "Agent surfaced the 6-month passport rule risk and did not silently book through it.",
    }),
  ],
});
