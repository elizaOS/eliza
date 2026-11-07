/**
 * A sensitive control value must never reach a template. Labels, descriptions,
 * ask prompts and examples are rendered into the model context and into
 * replies, so a `{{placeholder}}` for a sensitive key would echo the secret.
 */
import { describe, expect, it } from "vitest";
import { buildTemplateValues, renderTemplate } from "./template";
import type { FormControl, FormSession } from "./types";

const SECRET = "hunter123";

const controls: FormControl[] = [
  {
    key: "pin",
    label: "PIN",
    type: "text",
    required: true,
    sensitive: true,
  },
  {
    key: "confirm",
    label: "Confirm PIN",
    type: "text",
    required: true,
    askPrompt: "Re-enter the PIN you chose ({{pin}})",
  },
  {
    key: "nickname",
    label: "Nickname",
    type: "text",
    required: true,
    askPrompt: "Your nickname ({{nickname}})",
  },
];

const session = (): FormSession =>
  ({
    id: "session-1",
    formId: "pin-reset",
    formVersion: 1,
    entityId: "entity-1",
    roomId: "room-1",
    status: "active",
    context: {},
    fields: {
      pin: { status: "filled", value: SECRET },
      nickname: { status: "filled", value: "ada" },
    },
    effort: { startedAt: 0, lastInteractionAt: 0, timeSpentMs: 0 },
    nudgeCount: 0,
    createdAt: 0,
    updatedAt: 0,
    expiresAt: 0,
  }) as FormSession;

describe("sensitive values in form templates", () => {
  it("masks a sensitive value instead of rendering it", () => {
    const values = buildTemplateValues(session(), controls);
    const prompt = renderTemplate(controls[1]?.askPrompt, values);
    expect(prompt).toBe("Re-enter the PIN you chose (****)");
    expect(prompt).not.toContain(SECRET);
  });

  it("still renders an ordinary value", () => {
    const values = buildTemplateValues(session(), controls);
    expect(renderTemplate(controls[2]?.askPrompt, values)).toBe(
      "Your nickname (ada)",
    );
  });
});
