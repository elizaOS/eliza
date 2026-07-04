/**
 * Live-LLM evidence scenario (#11856): a REAL model must route a natural "join
 * this meeting and take notes" request (with a Google Meet URL) to the real
 * JOIN_MEETING handler. MeetingService then attempts a genuine browser join; on
 * a headless/keyless-Chrome host the join fails at the browser/admission step,
 * which is fine — the trajectory proves planner → JOIN_MEETING → MeetingService
 * with the real error surfaced.
 */
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";

export default {
  id: "live-join-meeting",
  lane: "live-only",
  title: "Real LLM routes a Meet link to JOIN_MEETING (plugin-meetings)",
  domain: "meetings",
  tags: ["live", "real-llm", "meetings", "join-meeting"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-meetings"],
  },
  rooms: [{ id: "main", source: "chat", title: "Live Meeting Join" }],
  turns: [
    {
      kind: "message",
      name: "user asks the agent to join a Google Meet and take notes",
      room: "main",
      text: "Please join this meeting and take notes: https://meet.google.com/abc-defg-hij",
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      name: "planner selected JOIN_MEETING",
      actionName: "JOIN_MEETING",
    },
    {
      type: "actionCalled",
      name: "JOIN_MEETING handler executed",
      actionName: "JOIN_MEETING",
      minCount: 1,
    },
  ],
} satisfies ScenarioDefinition;
