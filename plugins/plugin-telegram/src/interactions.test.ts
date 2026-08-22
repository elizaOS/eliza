/**
 * Unit tests for `renderTelegramInteractions`: plain replies pass through with no
 * keyboard, choice blocks render as callback buttons with the marker stripped,
 * and task cards link out when a url resolver exists or drop entirely when not.
 * Deterministic; no live API.
 */
import type { Content } from "@elizaos/core";
import {
  buildInteractionUrlResolver,
  decodeCallback,
  FORM_FREE_TEXT_INVITE,
} from "@elizaos/core";
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

  it("does not ship an unclaimed terminal marker when no controls parse", () => {
    const out = renderTelegramInteractions({
      text: "Done.\r\n[ FOLLOWUPS ]\r\nreply:More=More",
    } as Content);
    expect(out.text).toBe("Done.");
    expect(out.keyboardRows).toEqual([]);
  });

  it("renders spaced CRLF followups as native controls", () => {
    const out = renderTelegramInteractions({
      text: "Done.\r\n[ FOLLOWUPS ]\r\nreply:More=More\r\n[ / FOLLOWUPS ]",
    } as Content);
    expect(out.text).toBe("Done.");
    expect(out.keyboardRows[0]?.[0]).toMatchObject({ text: "More" });
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

  it("drops a url-less task card entirely instead of a dangling title line", () => {
    // Core contract since 2026-08-19: without a resolvable link the task
    // widget contributes nothing to chat text — the bare title rendered as a
    // duplicate line under the ack prose on chat transports.
    const id = "abc12345-def6-7890-abcd-ef1234567890";
    const out = renderTelegramInteractions({
      text: `Created the task.\n\n[TASK:${id}]Ship it[/TASK]`,
    } as Content);
    expect(out.text).toBe("Created the task.");
    expect(out.keyboardRows).toHaveLength(0);
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
  // #14321 — no hosted /forms/:id page exists; the canonical resolver must not
  // mint a dead link-out. The form renders as prose + a free-text invite.
  it("renders a form as prose + free-text fallback, never a dead link (#14321)", () => {
    const out = renderTelegramInteractions(
      {
        text: 'Happy to set that up.\n[FORM]\n{"id":"f1","title":"Set your reminder","fields":[{"name":"when","type":"text"}]}\n[/FORM]',
      } as Content,
      buildInteractionUrlResolver("https://app.test"),
    );
    expect(out.keyboardRows).toHaveLength(0);
    expect(out.needsFreeTextReply).toBe(true);
    expect(out.text).toContain("Set your reminder");
    expect(out.text).toContain(FORM_FREE_TEXT_INVITE);
    expect(out.text).not.toContain("/forms/");
  });
});

describe("dashboard-only marker stripping (Finding B)", () => {
  it("strips [CONFIG:…] from delivered text while native keyboards still render", () => {
    const rendered = renderTelegramInteractions({
      text: "Connect your calendar first.\n\n[CONFIG:google_calendars]\n\n[FOLLOWUPS]\nreply:yes=Yes\n[/FOLLOWUPS]",
    } as never);
    expect(rendered.text).not.toContain("[CONFIG:");
    expect(rendered.text).toContain("Connect your calendar first.");
    expect(rendered.keyboardRows.length).toBeGreaterThan(0);
  });

  it("strips [CONFIG:…] on the zero-block path too", () => {
    const rendered = renderTelegramInteractions({
      text: "Set up here: [CONFIG:@elizaos/plugin-gmail]",
    } as never);
    expect(rendered.text).toBe("Set up here:");
    expect(rendered.keyboardRows).toHaveLength(0);
  });

  it("drops a url-less task card even when its title carries a marker", () => {
    // Mirrors core's renderInteractionsAsPlainText contract: the url-less
    // task widget contributes NOTHING, so neither title nor marker leaks.
    const id = "abc12345-def6-7890-abcd-ef1234567890";
    const rendered = renderTelegramInteractions({
      text: `[TASK:${id}]Ship it [CONFIG:@elizaos/plugin-gmail][/TASK]`,
    } as Content);
    expect(rendered.text).toBe("");
    expect(rendered.keyboardRows).toHaveLength(0);
  });

  it("strips [CONFIG:…] from fallback prose contributed by a parsed block", () => {
    const form = JSON.stringify({
      title: "Configure account [CONFIG:@elizaos/plugin-gmail]",
      fields: [{ name: "account", type: "text" }],
    });
    const rendered = renderTelegramInteractions({
      text: `[FORM]\n${form}\n[/FORM]`,
    } as Content);
    expect(rendered.text).toContain("Configure account");
    expect(rendered.text).not.toContain("[CONFIG:");
    expect(rendered.keyboardRows).toHaveLength(0);
  });
});
