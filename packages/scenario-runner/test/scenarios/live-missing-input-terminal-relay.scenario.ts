/**
 * Live-model proof that a missing-input owner action ends in its explicit
 * clarification or a grammar-valid widget, never a trajectory-limit apology.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { validateSchedulingFormReply } from "./_helpers/chat-widgets";

const SYNTHETIC_FAILURE_RE =
  /sorry, something went wrong|trajectory limit|try again|failed on my end/i;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export default scenario({
  id: "live-missing-input-terminal-relay",
  lane: "live-only",
  title: "Missing-input reminder clarification reaches the owner",
  domain: "chat-widgets",
  tags: ["live", "real-llm", "planner-loop", "lifeops", "regression"],
  isolation: "per-scenario",
  rooms: [
    {
      id: "main",
      source: "eliza-app",
      title: "Missing Input Relay",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "missing reminder fields finish as a user-visible interaction",
      room: "main",
      text: "I need a reminder for an upcoming report deadline — you'll need the report name, the day, and the time from me.",
      assertTurn: (execution) => {
        const response = execution.responseText?.trim() ?? "";
        if (!response) return "missing-input turn returned an empty reply";
        if (SYNTHETIC_FAILURE_RE.test(response)) {
          return `missing-input turn returned a synthetic failure: ${JSON.stringify(response)}`;
        }

        const reminder = execution.actionsCalled.find(
          (action) => action.actionName === "OWNER_REMINDERS",
        );
        if (!reminder?.result) {
          return "OWNER_REMINDERS did not execute on the missing-input turn";
        }
        const data = record(reminder.result.data);
        if (data?.awaitingUserInput !== true) {
          return `OWNER_REMINDERS did not mark awaitingUserInput: ${JSON.stringify(data)}`;
        }
        const raw = record(reminder.result.raw);
        const userFacingText = raw?.userFacingText;
        if (typeof userFacingText !== "string" || !userFacingText.trim()) {
          return "OWNER_REMINDERS clarification did not declare userFacingText";
        }

        const parsedForm = validateSchedulingFormReply(response);
        if (typeof parsedForm !== "string") return undefined;
        if (response !== userFacingText.trim()) {
          return `reply was neither a valid scheduling form nor the action-owned clarification: ${JSON.stringify(response)}`;
        }
        return undefined;
      },
    },
  ],
});
