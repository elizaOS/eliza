import { describe, expect, it } from "vitest";
import {
  describeEmailTarget,
  type EmailTarget,
  fitEmailTarget,
  USE_IN_EMAIL_MAXIMUM,
} from "../../src/mailbox/use-in-email.ts";

const reply: EmailTarget = {
  ready: true,
  kind: "reply",
  append: false,
  reply: true,
  subject: "Re: Plan",
  to: ["sender@example.invalid"],
  from: "Sender",
  room: 100,
  token: "token",
  account: "owner@example.invalid",
};

describe("Use in email review", () => {
  it("names the literal address before the sender's own display name", () => {
    expect(describeEmailTarget(reply)).toEqual({
      account: "From owner@example.invalid",
      destination:
        "New reply to sender@example.invalid (Sender) · Re: Plan",
      effect: "A local draft opens with this text for you to edit.",
      confirmLabel: "Insert into draft",
      blocked: false,
    });
  });

  it("describes a set-aside draft that is not the message on screen", () => {
    const description = describeEmailTarget({
      ...reply,
      kind: "draft",
      aside: true,
      elsewhere: true,
      append: true,
      subject: " ",
      to: [],
    });
    expect(description.destination).toBe(
      "Your unfinished reply draft (not on screen) · (no subject) · to no recipients yet",
    );
    expect(description.effect).toMatch(
      /^This is not a reply to the message on screen\. This draft already has text/,
    );
    expect(description.confirmLabel).toBe("Add below existing text");
  });

  it("blocks with the destination's reason", () => {
    expect(
      describeEmailTarget({
        ready: false,
        reason: "Restore the saved draft first.",
        token: "blocked",
        account: "owner@example.invalid",
      }),
    ).toMatchObject({
      blocked: true,
      account: "From owner@example.invalid",
      effect: "Restore the saved draft first.",
    });
  });

  it("refuses a reply the destination cannot hold instead of cutting it", () => {
    expect(fitEmailTarget(reply, "x".repeat(100))).toBe(reply);
    const full = fitEmailTarget(reply, "x".repeat(101));
    expect(full.ready).toBe(false);
    expect(!full.ready && full.reason).toMatch(/does not have room/);
    const huge = fitEmailTarget(
      { ...reply, room: USE_IN_EMAIL_MAXIMUM * 2 },
      "x".repeat(USE_IN_EMAIL_MAXIMUM + 1),
    );
    expect(!huge.ready && huge.reason).toMatch(/longer than an email draft/);
  });
});
