/**
 * The Automations form builds the trigger request the server accepts: a text
 * automation is a prompt trigger, a cron schedule carries the zone it is
 * previewed in, and a one-time run carries the instant it is previewed at.
 */
import { describe, expect, it, test } from "vitest";
import type { TriggerSummary } from "../../../api/client-types-core";
import {
  buildCreateRequest,
  buildUpdateRequest,
  emptyForm,
  formFromTrigger,
  nextRunsForCron,
  onceInstant,
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

  it("sends a one-time run as the instant the browser previews", () => {
    // A datetime-local input gives a wall-clock value with no zone. The agent
    // host can run in another zone, so the request carries the instant.
    const once: TriggerFormState = {
      ...textCron,
      triggerType: "once",
      scheduledAtIso: "2026-10-14T09:00",
    };
    expect(validateForm(once, t)).toBeNull();
    expect(buildCreateRequest(once).scheduledAtIso).toBe(
      new Date("2026-10-14T09:00").toISOString(),
    );
  });

  it("opens a stored one-time run as a local wall-clock time", () => {
    const form = formFromTrigger({
      ...storedPrompt,
      triggerType: "once",
      scheduledAtIso: "2026-10-14T16:00:00.000Z",
    });
    expect(form.scheduledAtIso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(new Date(form.scheduledAtIso).toISOString()).toBe(
      "2026-10-14T16:00:00.000Z",
    );
    expect(buildUpdateRequest(form).scheduledAtIso).toBe(
      "2026-10-14T16:00:00.000Z",
    );
  });

  it("saves an unchanged repeated fall-back time as the stored instant", () => {
    // 01:30 happens twice in New York on 2026-11-01. The input text names
    // the first one; an edit that leaves the field alone keeps the second.
    const zone = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const form = formFromTrigger({
        ...storedPrompt,
        triggerType: "once",
        scheduledAtIso: "2026-11-01T06:30:00.000Z",
      });
      expect(form.scheduledAtIso).toBe("2026-11-01T01:30");
      expect(buildUpdateRequest(form).scheduledAtIso).toBe(
        "2026-11-01T06:30:00.000Z",
      );
      // A new time typed into the field is read in the browser zone.
      expect(
        buildUpdateRequest({ ...form, scheduledAtIso: "2026-11-01T03:00" })
          .scheduledAtIso,
      ).toBe("2026-11-01T08:00:00.000Z");
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });

  it("previews a cron schedule in the zone it runs in", () => {
    const from = new Date("2026-10-11T00:00:00.000Z");
    expect(
      nextRunsForCron("0 9 * * 1-5", 1, from, "America/Los_Angeles"),
    ).toEqual([new Date("2026-10-12T16:00:00.000Z")]);
  });
});

test("preview resolver preserves precision of unchanged stored instant", () => {
  for (const instant of ["2026-11-01T06:30:00.000Z", "2026-10-14T16:00:42.123Z"]) {
    const form = formFromTrigger({...storedPrompt, triggerType: "once", scheduledAtIso: instant});
    expect(onceInstant(form)).toBe(instant);
    expect(buildUpdateRequest(form).scheduledAtIso).toBe(onceInstant(form));
    form.scheduledAtIso = "2026-11-02T09:15";
    expect(onceInstant(form)).toBe(new Date(form.scheduledAtIso).toISOString());
  }
});
