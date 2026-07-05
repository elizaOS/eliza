/**
 * Built-in inline chat-reply widgets, registered into the inline-widget
 * registry at module load. Importing this module (a side effect) is what makes
 * `[CHOICE]`, `[FOLLOWUPS]`, and `[FORM]` markers render in chat.
 *
 * Each entry pairs the marker's parser (the parsing semantics) with its React
 * renderer, the same contract a plugin uses via `registerInlineWidget`. The
 * `[TASK]` widget is intentionally NOT here — it is owned and registered by the
 * orchestrator plugin (see `registerTaskWidget` in `./task-widget`).
 */

import {
  type ChecklistMatch,
  findChecklistRegions,
} from "../message-checklist-parser";
import { type ChoiceMatch, findChoiceRegions } from "../message-choice-parser";
import {
  type FollowupsMatch,
  findFollowupsRegions,
} from "../message-followups-parser";
import { type FormMatch, findFormRegions } from "../message-form-parser";
import {
  findWorkflowRegions,
  type WorkflowMatch,
} from "../message-workflow-parser";
import { ChoiceWidget } from "./ChoiceWidget";
import { FollowupsWidget } from "./followups";
import { FormRequest } from "./form-request";
import { registerInlineWidget } from "./inline-registry";
import { PlanChecklist } from "./task-pipeline";
import { WorkflowSteps } from "./workflow-steps";

registerInlineWidget<ChoiceMatch>({
  kind: "choice",
  parse: (text) => findChoiceRegions(text).map((m) => ({ ...m, data: m })),
  keyFor: (m) => `choice:${m.id}`,
  render: (m, ctx, key) => (
    <ChoiceWidget
      key={key}
      id={m.id}
      scope={m.scope}
      options={m.options}
      allowCustom={m.allowCustom}
      onChoose={ctx.sendAction}
    />
  ),
});

registerInlineWidget<FollowupsMatch>({
  kind: "followups",
  parse: (text) => findFollowupsRegions(text).map((m) => ({ ...m, data: m })),
  keyFor: (m) => `followups:${m.id}`,
  render: (m, ctx, key) => (
    <FollowupsWidget
      key={key}
      id={m.id}
      options={m.options}
      onChoose={ctx.sendAction}
      onNavigate={ctx.navigate}
      onPrompt={ctx.prefillComposer}
    />
  ),
});

registerInlineWidget<FormMatch>({
  kind: "form",
  parse: (text) => findFormRegions(text).map((m) => ({ ...m, data: m })),
  keyFor: (m) => `form:${m.form.id}`,
  render: (m, ctx, key) => (
    <FormRequest key={key} form={m.form} onSubmit={ctx.submitForm} />
  ),
});

registerInlineWidget<WorkflowMatch>({
  kind: "workflow",
  parse: (text) => findWorkflowRegions(text).map((m) => ({ ...m, data: m })),
  keyFor: (m) => `workflow:${m.workflow.id}`,
  render: (m, _ctx, key) => <WorkflowSteps key={key} workflow={m.workflow} />,
});

registerInlineWidget<ChecklistMatch>({
  kind: "checklist",
  parse: (text) => findChecklistRegions(text).map((m) => ({ ...m, data: m })),
  keyFor: (m) => `checklist:${m.checklist.items.length}`,
  render: (m, _ctx, key) => (
    <div
      key={key}
      className="my-2 rounded-sm border border-border bg-card px-3 py-2"
    >
      <PlanChecklist
        entries={m.checklist.items}
        title={m.checklist.title ?? "Checklist"}
      />
    </div>
  ),
});
