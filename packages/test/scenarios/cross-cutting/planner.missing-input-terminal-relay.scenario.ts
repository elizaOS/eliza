/**
 * Live-model proof that an owner action's explicit missing-input marker may
 * authorize a clarification or grammar-valid scheduling form.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

const FAILURE_RE =
  /sorry, something went wrong|trajectory limit|try again|failed on my end/i;
const FORM_RE = /^\[FORM\]\s*([\s\S]*)\s*\[\/FORM\]$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validSchedulingForm(text: string): boolean {
  const match = FORM_RE.exec(text);
  if (!match?.[1]) return false;
  try {
    const payload: unknown = JSON.parse(match[1]);
    if (!isRecord(payload) || !Array.isArray(payload.fields)) return false;
    const names = payload.fields.flatMap((field) =>
      isRecord(field) && typeof field.name === "string" ? [field.name] : [],
    );
    return names.includes("date") && names.includes("time");
  } catch {
    // error-policy:J3 invalid model-authored form JSON is an explicit failed match
    return false;
  }
}

export default scenario({
  id: "live-missing-input-terminal-relay",
  lane: "live-only",
  title: "Missing-input reminder clarification reaches the owner",
  domain: "planner-loop",
  tags: ["live", "real-llm", "planner-loop", "lifeops", "15967"],
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
      text: "I need a reminder for an upcoming report deadline — ask me for the report name, day, and time before creating anything.",
      assertTurn: (execution) => {
        const response = execution.responseText?.trim() ?? "";
        if (!response) return "missing-input turn returned an empty reply";
        if (FAILURE_RE.test(response)) {
          return `missing-input turn returned a synthetic failure: ${JSON.stringify(response)}`;
        }
        const reminder = execution.actionsCalled.find(
          (action) => action.actionName === "OWNER_REMINDERS",
        );
        if (!reminder?.result) return "OWNER_REMINDERS did not execute";
        if (
          !isRecord(reminder.result.data) ||
          reminder.result.data.awaitingUserInput !== true
        ) {
          return `OWNER_REMINDERS lacked awaitingUserInput: ${JSON.stringify(reminder.result.data)}`;
        }
        if (!isRecord(reminder.result.raw)) {
          return "OWNER_REMINDERS lacked a raw action result";
        }
        const actionText = reminder.result.raw.userFacingText;
        if (typeof actionText !== "string" || !actionText.trim()) {
          return "OWNER_REMINDERS clarification lacked userFacingText";
        }
        if (!validSchedulingForm(response) && response !== actionText.trim()) {
          return `reply was neither a scheduling form nor the action clarification: ${JSON.stringify(response)}`;
        }
        return undefined;
      },
    },
  ],
});
