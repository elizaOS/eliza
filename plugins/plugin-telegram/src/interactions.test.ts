/**
 * Unit tests for `renderTelegramInteractions`: plain replies pass through with no
 * keyboard, choice blocks render as callback buttons with the marker stripped,
 * and task cards link out or stay as text depending on the url resolver.
 * Deterministic; no live API.
 */
import type { Content } from "@elizaos/core";
import { buildInteractionUrlResolver, decodeCallback } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { renderTelegramInteractions } from "./interactions";

describe("renderTelegramInteractions", () => {
  it("passes plain replies through with no keyboard", () => {
    const out = renderTelegramInteractions({
      text: "just a normal reply",
    } as Content);
    expect(out.text).toBe("just a normal reply");
    expect(out.keyboardRows).toHaveLength(0);
    expect(out.needsFreeTextReply).toBe(false);
  });

  it("renders a choice block as callback buttons and strips the marker", () => {
    const content: Content = {
      text: "Approve the deploy?\n[CHOICE:approve id=c1]\nyes=Yes, ship it\nno=Cancel\n[/CHOICE]",
    };
    const out = renderTelegramInteractions(content);
    expect(out.text).toBe("Approve the deploy?");
    expect(out.keyboardRows).toHaveLength(1);
    const buttons = out.keyboardRows[0];
    expect(buttons).toHaveLength(2);
    // the button carries an interaction callback that decodes to the option value
    const first = buttons[0] as { text: string; callback_data: string };
    expect(first.text).toBe("Yes, ship it");
    expect(decodeCallback(first.callback_data)).toEqual({
      kind: "reply",
      value: "yes",
    });
  });

  it("links a task card out when a url resolver is provided", () => {
    const id = "abc12345-def6-7890-abcd-ef1234567890";
    const content: Content = { text: `[TASK:${id}]Ship the thing[/TASK]` };
    const out = renderTelegramInteractions(content, {
      resolveUrl: (b) =>
        b.kind === "task"
          ? `https://app/tasks?taskId=${b.threadId}`
          : undefined,
    });
    const button = out.keyboardRows[0]?.[0] as { text: string; url: string };
    expect(button.text).toBe("Open task");
    expect(button.url).toContain(id);
  });

  it("keeps a task title as text when no url is available", () => {
    const id = "abc12345-def6-7890-abcd-ef1234567890";
    const out = renderTelegramInteractions({
      text: `[TASK:${id}]Ship it[/TASK]`,
    } as Content);
    expect(out.text).toContain("Ship it");
    expect(out.keyboardRows).toHaveLength(0);
  });

  it("renders a [FORM] as free-text prose with NO dead /forms/ button, using the real url resolver (#14321)", () => {
    // The exact wiring the connector uses in production (messageManager.ts:970).
    const resolver = buildInteractionUrlResolver("https://app.test");
    const content: Content = {
      text: `Let's get your trip details.\n[FORM]\n${JSON.stringify({
        title: "Trip details",
        description: "Where and when?",
        fields: [
          { name: "dest", type: "text", label: "Destination" },
          { name: "when", type: "text", label: "When" },
        ],
      })}\n[/FORM]`,
    };
    const out = renderTelegramInteractions(content, resolver);
    // No hosted /forms/:id page exists → the connector must not render a button.
    expect(out.keyboardRows).toHaveLength(0);
    // The prose (cleaned text + the form's own title) is preserved for the user.
    expect(out.text).toContain("Let's get your trip details.");
    expect(out.text).toContain("Trip details");
    // The user is invited to answer in free text instead of a broken control.
    expect(out.needsFreeTextReply).toBe(true);
    // Adversarial: prove no button ANYWHERE carries a /forms/ URL.
    const urls = out.keyboardRows
      .flat()
      .map((b) => (b as { url?: string }).url ?? "");
    expect(urls.some((u) => u.includes("/forms/"))).toBe(false);
    expect(out.text).not.toContain("/forms/");
  });

  it("renders a navigate followup as a URL button via resolveNavigateUrl (#8908)", () => {
    const content: Content = {
      text: "Done.\n[FOLLOWUPS id=f1]\nnavigate:/orchestrator=Open tasks\nreply:thanks=Thanks\n[/FOLLOWUPS]",
    };
    const out = renderTelegramInteractions(content, {
      resolveNavigateUrl: (p) => `https://app.test${p}`,
    });
    const buttons = out.keyboardRows.flat() as Array<{
      text: string;
      url?: string;
      callback_data?: string;
    }>;
    const nav = buttons.find((b) => b.text === "Open tasks");
    const reply = buttons.find((b) => b.text === "Thanks");
    expect(nav?.url).toBe("https://app.test/orchestrator");
    expect(reply?.url).toBeUndefined();
    expect(reply?.callback_data).toBeTruthy();
  });
});
