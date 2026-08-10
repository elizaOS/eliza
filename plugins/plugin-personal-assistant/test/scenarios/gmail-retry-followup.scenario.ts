/**
 * Live-model Gmail retry/refinement scenario (#9310): runs against the loopback
 * official Gmail MCP fixture and asserts the initial search, retry, and unread
 * refinement each execute search_threads. The curated surface has no send tool,
 * and the scenario forbids every available Gmail MCP write.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  GMAIL_MCP_MESSAGES,
  GMAIL_MCP_WRITE_TOOLS,
  gmailSearchFixture,
} from "../scenario-support/gmail-mcp-fixtures.ts";

export default scenario({
  lane: "live-only",
  id: "gmail-retry-followup",
  title: "Gmail retry and refinement re-run the curated MCP search",
  domain: "gmail",
  tags: ["lifeops", "gmail", "executive-assistant", "outcome"],
  isolation: "per-scenario",
  requires: {
    credentials: ["gmail:test-owner"],
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "discord",
      title: "LifeOps Gmail Retry Follow-up",
    },
  ],
  seed: [
    gmailSearchFixture([GMAIL_MCP_MESSAGES.sarahProductBrief], {
      repeat: true,
    }),
  ],
  turns: [
    {
      kind: "message",
      name: "gmail initial search",
      room: "main",
      text: "find emails from sarah",
      plannerIncludesAll: ["gmail_action"],
      plannerExcludes: [
        "create_task",
        "spawn_agent",
        "send_to_agent",
        "list_agents",
      ],
    },
    {
      kind: "message",
      name: "gmail retry follow-up",
      room: "main",
      text: "can you try that sarah search again?",
      responseExcludes: ["no active task agents", "spawned", "scratch/"],
    },
    {
      kind: "message",
      name: "gmail unread refinement",
      room: "main",
      text: "what about unread ones?",
      plannerIncludesAll: ["gmail_action"],
      plannerExcludes: [
        "create_task",
        "spawn_agent",
        "send_to_agent",
        "list_agents",
      ],
    },
  ],
  finalChecks: [
    // OUTCOME: the search and retry each execute the curated MCP tool.
    {
      type: "mcpToolCall",
      name: "initial search, retry, and refinement execute search_threads",
      provider: "google",
      resource: "gmail",
      tool: "search_threads",
      minCount: 3,
    },
    {
      type: "mcpToolCall",
      name: "search flow makes no Gmail MCP write",
      provider: "google",
      resource: "gmail",
      tool: GMAIL_MCP_WRITE_TOOLS,
      expected: false,
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "gmail-retry-end-to-end",
      minimumScore: 0.7,
      rubric:
        "End-to-end: the assistant executed the Sarah inbox search, re-ran it on the retry request instead of claiming stale results or spawning agents, and narrowed to unread messages on the refinement — all through curated search_threads MCP calls.",
    },
  ],
});
