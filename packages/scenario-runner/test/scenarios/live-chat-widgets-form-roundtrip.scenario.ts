/**
 * Live-model FORM widget round trip (#14322). A vague scheduling request must
 * make the real model emit a grammar-valid `[FORM]` block (per the uiWidgets
 * guide: one inline JSON line, native date/time/datetime fields for any
 * scheduling input — #14484). The harness then plays the dashboard user: it
 * parses the block exactly like the renderer does and re-enters the submit as
 * the literal `[form:submit <id>] {json}` wire message
 * (use-inline-widget-context.ts). The agent's next turn must consume that raw
 * re-entry — confirm using the SUBMITTED values and route them into a real
 * domain action (scheduled task / reminder / todo), not re-ask or echo JSON.
 *
 * There is no server-side consumer of `[form:submit …]`; the whole round trip
 * is trusted text re-entry, which is exactly what this scenario puts under
 * live test. Needs live model credentials (live-only lane).
 *
 * Regression target: #14322 found that the v5 evaluator message-to-user path
 * could reject JSON-bodied interaction markers, making `[FORM]` unreachable
 * even when the guide was present. The evaluator contract fix landed
 * separately; this live-only scenario keeps grammar-valid form emission,
 * raw submit re-entry, and submitted-value consumption pinned end to end.
 */

import { scenario } from "@elizaos/scenario-runner/schema";
import type { FormInteraction } from "../../../core/src/types/interactions.ts";
import {
  buildFormSubmitText,
  CANONICAL_FORM_DATE,
  fillFormValues,
  uiWidgetsGuideSeed,
  validateSchedulingFormReply,
} from "./_helpers/chat-widgets";

// Turn 1 captures the parsed form here; turn 2's lazy `text` getter builds the
// submit wire message from it. Reset in seed so reruns on a shared runtime
// never replay a stale form id.
let capturedForm: FormInteraction | null = null;
let submittedValues: Record<string, string | number | boolean> = {};

// Conversational/action-selection plumbing that must NOT count as the domain
// write the submitted values are supposed to reach.
const CONVERSATIONAL_ACTIONS = new Set(["REPLY", "IGNORE", "NONE"]);

// The distinctive tokens from CANONICAL_FORM_TEXT_VALUE — proof the agent used
// what the user typed into the form, not something it invented.
const SUBMITTED_TOKEN_RE = /q3|budget|dana/i;

export default scenario({
  id: "live-chat-widgets-form-roundtrip",
  lane: "live-only",
  status: "pending",
  title: "Real LLM emits a [FORM], consumes the raw [form:submit] re-entry",
  domain: "chat-widgets",
  tags: ["live", "real-llm", "chat-widgets", "form", "lifeops"],
  isolation: "per-scenario",
  seed: [
    uiWidgetsGuideSeed(),
    {
      type: "custom",
      name: "reset captured form state",
      apply: () => {
        capturedForm = null;
        submittedValues = {};
        return undefined;
      },
    },
  ],
  rooms: [
    {
      id: "main",
      source: "eliza-app",
      title: "Chat Widgets Form",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "multi-detail reminder request must yield a scheduling [FORM]",
      room: "main",
      // Deliberately leaves SEVERAL values open (name + day + time): the
      // uiWidgets guide only licenses [FORM] when multiple specific values are
      // needed ("do NOT use it for a single free-text answer — just ask"), so
      // a one-unknown phrasing ("remind me about my report") legitimately gets
      // a prose question instead of a form (observed live — see
      // evidence-14322/form-report-attempt2.json).
      text: "I need a reminder for an upcoming report deadline — you'll need the report name, the day, and the time from me.",
      assertTurn: (execution) => {
        const result = validateSchedulingFormReply(
          execution.responseText ?? "",
        );
        if (typeof result === "string") {
          return result;
        }
        capturedForm = result;
        submittedValues = fillFormValues(result);
        return undefined;
      },
    },
    {
      kind: "message",
      name: "raw [form:submit] re-entry must be consumed, not re-asked",
      room: "main",
      // Built lazily from the form the model ACTUALLY emitted in turn 1 —
      // field names, id, everything. The fallback keeps the executor from
      // throwing on empty text when turn 1 already failed.
      get text() {
        if (!capturedForm) {
          return '[form:submit form-missing] {"error":"no form captured in turn 1"}';
        }
        return buildFormSubmitText(capturedForm, submittedValues);
      },
      responseExcludes: [/\[FORM\]/],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The user just submitted a structured form containing reminder details: " +
          "a title/description mentioning a Q3 budget report (for Dana), and — when the " +
          "form had a date/time field — the local time 2026-07-14 09:30. The assistant " +
          "must confirm the reminder/task using those submitted values (the report topic " +
          "and, if given, the requested day/time). It must NOT ask again for details it " +
          "already received, must NOT show the raw submitted JSON back to the user, and " +
          "must NOT claim it could not read the submission.",
      },
      assertTurn: (execution) => {
        const text = execution.responseText ?? "";
        if (!SUBMITTED_TOKEN_RE.test(text)) {
          return `post-submit reply never references the submitted values (expected a Q3/budget/Dana mention): ${JSON.stringify(text.slice(0, 400))}`;
        }
        return undefined;
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "submitted values reached a real domain action (not just prose)",
      predicate: (ctx) => {
        const domainWrites = ctx.actionsCalled.filter((action) => {
          if (CONVERSATIONAL_ACTIONS.has(action.actionName)) return false;
          const payload = JSON.stringify({
            parameters: action.parameters ?? null,
            result: action.result ?? null,
          });
          return SUBMITTED_TOKEN_RE.test(payload);
        });
        if (domainWrites.length === 0) {
          const seen = ctx.actionsCalled
            .map((action) => action.actionName)
            .join(", ");
          return `no non-conversational action carried the submitted form values (actions called: ${seen || "none"})`;
        }
        const failed = domainWrites.every(
          (action) => action.result?.success === false || action.error,
        );
        if (failed) {
          return `domain action(s) received the submitted values but none succeeded: ${domainWrites
            .map(
              (action) =>
                `${action.actionName}(${action.error?.message ?? "success=false"})`,
            )
            .join(", ")}`;
        }
        return undefined;
      },
    },
    {
      type: "custom",
      name: "submitted schedule date reached the domain action when a temporal field existed",
      predicate: (ctx) => {
        if (!capturedForm) return "no form was captured in turn 1";
        const hadTemporalField = capturedForm.fields.some((field) =>
          ["date", "time", "datetime"].includes(field.type),
        );
        if (!hadTemporalField) return undefined;
        const dateReached = ctx.actionsCalled.some((action) => {
          if (CONVERSATIONAL_ACTIONS.has(action.actionName)) return false;
          const payload = JSON.stringify({
            parameters: action.parameters ?? null,
            result: action.result ?? null,
          });
          return payload.includes(CANONICAL_FORM_DATE);
        });
        return dateReached
          ? undefined
          : `no non-conversational action carried the submitted date ${CANONICAL_FORM_DATE}`;
      },
    },
  ],
});
