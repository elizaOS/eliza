/** Stage 1 leads its user message with the room's static catalog and Task text,
 * so consecutive turns share that prefix. Live tj-786ca91739ceaa: every Stage-1
 * call opened with the clock line and cached only the system and tool prefix. */
import type { ContextEvent, IAgentRuntime } from "@elizaos/core";
import { expect, it } from "vitest";
import { renderMessageHandlerModelInput } from "./stage1-input";

const runtime = { character: { name: "Alpha" } } as IAgentRuntime;
const contexts = [
  { id: "simple", description: "Answer from supplied context without tools." },
  { id: "calendar", description: "Events, appointments and availability." },
];

function turn(clock: string, request: string): string {
  const events: ContextEvent[] = [
    {
      id: "time",
      type: "provider",
      name: "TIME",
      text: `Local date: ${clock}`,
    },
    {
      id: "effects",
      type: "segment",
      segment: {
        id: "effects",
        label: "runtime:historical_effects",
        content: '{"outcomes":[{"actionName":"CALENDAR_CREATE_EVENT"}]}',
        stable: false,
      },
    },
    {
      id: "current-turn-boundary",
      type: "instruction",
      source: "message-service",
      stable: false,
      content: "Answer the current request.",
    },
    {
      id: "current",
      type: "message",
      message: { id: "current", role: "user", content: request },
    },
  ];
  const input = renderMessageHandlerModelInput(
    runtime,
    { id: "turn", events },
    contexts,
    { directMessage: true, nativeTools: true },
  );
  return String(input.messages[1]?.content);
}

it("puts the catalog and Task ahead of the clock, past effects and the boundary", () => {
  const user = turn("4:01:04 AM", "move it to 4pm");
  const task = user.indexOf("# Task");
  const clock = user.indexOf("Local date:");
  const effects = user.indexOf("runtime:historical_effects");
  const boundary = user.indexOf("Answer the current request.");
  const conversation = user.indexOf("# Conversation");
  expect(user.startsWith("# Available Contexts\n- simple:")).toBe(true);
  expect(task).toBeGreaterThan(0);
  expect(clock).toBeGreaterThan(task);
  expect(effects).toBeGreaterThan(clock);
  expect(boundary).toBeGreaterThan(effects);
  expect(conversation).toBeGreaterThan(boundary);
  expect(user.indexOf("# Current message")).toBeGreaterThan(conversation);
});

it("shares the catalog and Task prefix between turns", () => {
  const first = turn("4:01:04 AM", "move it to 4pm");
  const second = turn("4:01:36 AM", "remind me to stretch in 20 minutes");
  let shared = 0;
  while (shared < first.length && first[shared] === second[shared]) shared++;
  expect(first.slice(0, shared)).toContain(
    "otherwise call HANDLE_RESPONSE with its registered fields.",
  );
});
