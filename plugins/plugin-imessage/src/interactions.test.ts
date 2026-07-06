/**
 * Deterministic coverage for iMessage's text-only interaction rendering. The
 * tests assert markers are stripped before iMessage chunking, so a large form
 * JSON body cannot be split into user-visible bracket fragments.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", async () => await vi.importActual("@elizaos/core"));

import { renderIMessageInteractionText } from "./interactions";
import { splitMessageForIMessage } from "./types";

describe("renderIMessageInteractionText", () => {
  it("strips choice markers and appends a numbered fallback", () => {
    const rendered = renderIMessageInteractionText({
      text: "Choose:\n[CHOICE:approval id=c1 allow_custom]\nyes=Approve\nno=Decline\n[/CHOICE]",
    });

    expect(rendered).toBe(
      "Choose:\n\n1. Approve\n2. Decline\nReply with a number or your own answer."
    );
    expect(rendered).not.toContain("[CHOICE");
  });

  it("strips form JSON before chunking", () => {
    const fields = Array.from({ length: 20 }, (_, index) => ({
      name: `field_${index}`,
      type: "text",
      label: "x".repeat(250),
    }));
    const raw = `Please fill this out.\n[FORM]\n${JSON.stringify({
      title: "Long intake",
      description: "Tell me what changed.",
      fields,
    })}\n[/FORM]`;

    const rendered = renderIMessageInteractionText({ text: raw });
    const chunks = splitMessageForIMessage(rendered, 160);

    expect(rendered).toContain("Long intake");
    expect(rendered).toContain("Reply with your answer.");
    expect(rendered).not.toContain("[FORM]");
    expect(rendered).not.toContain("[/FORM]");
    expect(chunks.every((chunk) => !chunk.includes("[FORM]"))).toBe(true);
    expect(chunks.every((chunk) => !chunk.includes("[/FORM]"))).toBe(true);
  });

  it("adds task links when an app base url is configured", () => {
    const rendered = renderIMessageInteractionText(
      {
        text: "[TASK:abc12345]Review the device lane[/TASK]",
      },
      "https://app.test/"
    );

    expect(rendered).toBe("Review the device lane\nhttps://app.test/orchestrator?taskId=abc12345");
  });
});
