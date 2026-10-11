/**
 * The Automations form builds the trigger request the server accepts: a text
 * automation is a prompt trigger, and a cron schedule carries the zone it is
 * previewed in.
 */
import { describe, expect, it } from "vitest";
import type { TriggerSummary } from "../../../api/client-types-core";
import {
  buildCreateRequest,
  buildUpdateRequest,
  emptyForm,
  formFromTrigger,
  nextRunsForCron,
  type TriggerFormState,
  validateForm,
} from "../trigger-form-utils";

const t = (key: string) => key;
const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const textCron: TriggerFormState = {
  ...emptyForm,
  displayName: "Standup notes",
  instructions: "Write the standup notes.",
  kind: "text",
  triggerType: "cron",
  cronExpression: "0 9 * * 1-5",
};

const storedPrompt = {
  id: "trigger-1",
  displayName: "Standup notes",
  instructions: "Write the standup notes.",
  kind: "prompt",
  triggerType: "cron",
  cronExpression: "0 9 * * 1-5",
  wakeMode: "inject_now",
  enabled: true,
} as TriggerSummary;

describe("Automations trigger form", () => {
  it("accepts a text automation and creates it as a prompt in the browser zone", () => {
    expect(validateForm(textCron, t)).toBeNull();
    expect(buildCreateRequest(textCron)).toMatchObject({
      kind: "prompt",
      instructions: "Write the standup notes.",
      cronExpression: "0 9 * * 1-5",
      timezone: browserZone,
    });
  });

  it("requires instructions for text and a workflow for workflow", () => {
    expect(validateForm({ ...textCron, instructions: " " }, t)).toBe(
      "triggersview.validationInstructionsRequired",
    );
    expect(validateForm({ ...textCron, kind: "workflow" }, t)).toBe(
      "triggers.workflowPlaceholder",
    );
  });

  it("edits a stored prompt trigger as text and keeps its stored zone", () => {
    const form = formFromTrigger({ ...storedPrompt, timezone: "Asia/Tokyo" });
    expect(form.kind).toBe("text");
    expect(validateForm(form, t)).toBeNull();
    expect(buildUpdateRequest(form)).toMatchObject({
      kind: "prompt",
      timezone: "Asia/Tokyo",
    });
  });

  it("sends the browser zone when the edited cron trigger has no stored zone", () => {
    expect(buildUpdateRequest(formFromTrigger(storedPrompt)).timezone).toBe(
      browserZone,
    );
    expect(
      buildUpdateRequest({
        ...formFromTrigger(storedPrompt),
        triggerType: "interval",
      }).timezone,
    ).toBeUndefined();
  });

  it("previews a cron schedule in the zone it runs in", () => {
    const from = new Date("2026-10-11T00:00:00.000Z");
    expect(
      nextRunsForCron("0 9 * * 1-5", 1, from, "America/Los_Angeles"),
    ).toEqual([new Date("2026-10-12T16:00:00.000Z")]);
  });
});
