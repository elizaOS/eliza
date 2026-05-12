/**
 * Failure-recovery test: seed a corrupt todo memory row, then ask the
 * agent to show todos. The agent must respond gracefully — no uncaught
 * exception surfacing to the user, no raw stack traces in the response.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "cross.failure-recovery.action-fails-agent-retries",
  title: "Agent degrades gracefully when a todo memory row is corrupt",
  domain: "cross-cutting",
  tags: ["cross-cutting", "failure-recovery"],
  description:
    "A corrupt todo memory row is seeded. User asks for their todos. Agent must answer without leaking stack traces or 'undefined' into the response.",

  isolation: "per-scenario",

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Cross-cutting: failure recovery",
    },
  ],

  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "todo",
        status: "corrupt",
      },
    },
  ],

  turns: [
    {
      kind: "message",
      name: "show-todos",
      room: "main",
      text: "Please list my todos and reply with the list (or tell me if there are none).",
      responseJudge: {
        rubric:
          "Agent responds conversationally about todos (listing them, saying there are none, or acknowledging the request). Any response that does not leak raw stack traces or internal error details counts as a pass. The agent does not have to explicitly mention data issues.",
        minimumScore: 0.5,
      },
      assertResponse: (text: string) => {
        if (!text || text.trim().length === 0) {
          return "Expected a non-empty response";
        }
        if (/stacktrace|\bError:\s|TypeError|at\s+\w+\s+\(/i.test(text)) {
          return `Response leaked raw error / stack detail: ${text.slice(0, 200)}`;
        }
      },
    },
  ],

  finalChecks: [
    {
      // Accept REPLY or LIFE — both surface a user-visible response. LIFE is
      // the LifeOps todo-listing action; REPLY is the core chat fallback.
      type: "custom",
      name: "responded-to-user",
      predicate: async (ctx) => {
        const ok = ctx.actionsCalled.some(
          (a) => a.actionName === "REPLY" || a.actionName === "LIFE",
        );
        if (!ok) {
          const fired =
            ctx.actionsCalled.map((a) => a.actionName).join(", ") || "(none)";
          return `Expected REPLY or LIFE to respond to user; got: ${fired}`;
        }
      },
    },
  ],
});
