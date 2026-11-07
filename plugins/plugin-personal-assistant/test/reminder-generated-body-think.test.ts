/**
 * Reminder and workflow nudges are written by TEXT_SMALL. A reasoning model
 * returns its `<think>` block inline, and a model that hits its token cap
 * returns a `<think>` block with no close tag. Neither may reach the user.
 */
import { describe, expect, it } from "vitest";
import { RemindersDomain } from "../src/lifeops/domains/reminders-service.js";

function domainReturning(response: string): RemindersDomain {
  const runtime = {
    character: { name: "Eliza" },
    useModel: async () => response,
    reportError: () => undefined,
  };
  return new RemindersDomain({ runtime } as never, {} as never);
}

const run = {
  workflow: { title: "Morning stretch", subjectType: "owner" as const },
  run: { status: "success" as const },
};

describe("generated reminder text with reasoning", () => {
  it("drops a closed think block", async () => {
    const domain = domainReturning(
      "<think>\nThe user wants a short update.\n</think>\n\nYour morning stretch is done.",
    );
    expect(await domain.renderWorkflowRunBody(run)).toBe(
      "Your morning stretch is done.",
    );
  });

  it("uses the template when the think block has no close tag", async () => {
    const domain = domainReturning(
      "<think>\nThe user wants a short update. Rules: keep it",
    );
    expect(await domain.renderWorkflowRunBody(run)).toBe(
      "Morning stretch just ran successfully.",
    );
  });
});
