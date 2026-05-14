/**
 * Search — user searches for a topic across all messaging
 * platforms in one query. Agent must hit multiple channels (or honestly
 * report no matches per channel).
 *
 * Failure modes guarded:
 *   - searching only one channel
 *   - fabricating matches in channels the agent never hit
 *
 * Cited: 03-coverage-gap-matrix.md — cross-channel search.
 */

import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "cross-channel.search-across-platforms",
  title: "Search spans Gmail + Signal + Telegram",
  domain: "lifeops.cross-channel",
  tags: ["lifeops", "cross-channel", "search", "search-all"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Cross-Channel Search",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "topic-search",
      room: "main",
      text: "Search across everything — Gmail, Signal, Telegram — for anything about the Q4 budget discussion.",
      timeoutMs: 180_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "search-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["MESSAGE", "READ_MESSAGES"],
        description: "search across multiple channels for one topic",
        includesAny: ["q4", "budget", "gmail", "signal", "telegram"],
      }),
    },
    judgeRubric({
      name: "cross-channel-search-rubric",
      threshold: 0.7,
      description:
        "Agent issued search across at least Gmail, Signal, and Telegram for the Q4 budget topic — and reported real or honest no-match results, not fabricated matches.",
    }),
  ],
});
