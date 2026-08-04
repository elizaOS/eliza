/**
 * Validates the action provenance and owner-facing result captured by the
 * credentialed missing-input scenario without depending on model routing.
 */
import type { ScenarioTurnExecution } from "@elizaos/scenario-runner/schema";

const FAILURE_RE =
  /sorry, something went wrong|trajectory limit|try again|failed on my end/i;
const FORM_RE = /^\[FORM\]\s*([\s\S]*)\s*\[\/FORM\]$/;
const REMINDER_CREATE_ACTIONS = new Set([
  "OWNER_REMINDERS",
  "OWNER_REMINDERS_CREATE",
]);

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

export function expectMissingInputTerminalRelay(
  execution: ScenarioTurnExecution,
): string | undefined {
  const response = execution.responseText?.trim() ?? "";
  if (!response) return "missing-input turn returned an empty reply";
  if (FAILURE_RE.test(response)) {
    return `missing-input turn returned a synthetic failure: ${JSON.stringify(response)}`;
  }
  const reminder = execution.actionsCalled.find((action) =>
    REMINDER_CREATE_ACTIONS.has(action.actionName),
  );
  if (!reminder?.result) {
    const seen = execution.actionsCalled.map((action) => action.actionName);
    return `no reminder-create action executed (saw: ${seen.join(", ")})`;
  }
  if (reminder.result.success !== true) {
    return `reminder-create action did not succeed: ${JSON.stringify(reminder.result)}`;
  }
  if (
    !isRecord(reminder.result.data) ||
    reminder.result.data.awaitingUserInput !== true
  ) {
    return `reminder-create action lacked awaitingUserInput: ${JSON.stringify(reminder.result.data)}`;
  }
  if (!isRecord(reminder.result.raw)) {
    return "reminder-create action lacked a raw action result";
  }
  const actionText = reminder.result.raw.userFacingText;
  if (typeof actionText !== "string" || !actionText.trim()) {
    return "reminder-create clarification lacked userFacingText";
  }
  if (!validSchedulingForm(response) && response !== actionText.trim()) {
    return `reply was neither a scheduling form nor the action clarification: ${JSON.stringify(response)}`;
  }
  return undefined;
}
