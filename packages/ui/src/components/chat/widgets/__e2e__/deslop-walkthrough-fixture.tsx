/**
 * Walkthrough fixture for the chat-native widget de-slop: mounts the real
 * interactive widgets (choice → lock/collapse, form → submit/collapse,
 * checklist, workflow) so a recorded run demonstrates the chrome-free
 * rendering and the intact collapse-on-complete contract end to end.
 */
import { createRoot } from "react-dom/client";
import { ChoiceWidget } from "../ChoiceWidget";
import { FormRequest } from "../form-request";
import { ChecklistWidget } from "../task-pipeline";
import { WorkflowSteps } from "../workflow-steps";

const form = {
  id: "walkthrough-form",
  title: "Schedule a reminder",
  description: "Pick what to call it and when it should fire.",
  submitLabel: "Create reminder",
  fields: [
    { name: "title", label: "Title", type: "text" as const, required: true },
    { name: "when", label: "When", type: "time" as const },
    { name: "repeat", label: "Repeat daily", type: "checkbox" as const },
  ],
};

const workflow = {
  id: "walkthrough-workflow",
  title: "Deploy",
  steps: [
    { label: "Build image", status: "done" as const },
    { label: "Push to registry", status: "running" as const },
    { label: "Roll out", status: "pending" as const },
  ],
};

const checklist = [
  { content: "Draft the migration runbook", status: "completed" },
  { content: "Review with the on-call", status: "in_progress" },
  { content: "Schedule the maintenance window", status: "pending" },
];

function log(kind: string, value: string) {
  // The recorder asserts on these console lines.
  console.log(`[walkthrough] ${kind}: ${value}`);
}

const root = createRoot(document.getElementById("root") as HTMLElement);
root.render(
  <div
    className="mx-auto flex max-w-xl flex-col gap-6 p-5 text-txt"
    data-testid="deslop-walkthrough"
  >
    <div className="text-[15px] leading-[1.7]">
      Sure — I can set that up. A couple of quick questions:
    </div>
    <ChoiceWidget
      id="walkthrough-choice"
      scope="scheduling"
      options={[
        { value: "morning", label: "Morning (9am)" },
        { value: "evening", label: "Evening (7pm)" },
        { value: "cancel", label: "Cancel" },
      ]}
      onChoose={(v) => log("choice", v)}
    />
    <FormRequest form={form} onSubmit={(id) => log("form", id)} />
    <WorkflowSteps workflow={workflow} />
    <ChecklistWidget entries={checklist} title="Migration" />
  </div>,
);
