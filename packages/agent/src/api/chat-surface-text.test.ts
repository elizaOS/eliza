/**
 * Matrix F2 (tj-a5802a25580840, tj-a5c08d45c87a41, tj-a76213d5ae7164):
 * app-surface control blocks — [CONFIG:] cards and [FOLLOWUPS] grammar —
 * leaked verbatim into POST /api/agents/:id/message replies. That endpoint
 * serves chat-shaped consumers only (the dashboard uses the session/chat
 * routes), so the final projection renders grammar to its text fallbacks and
 * strips dashboard-only markers.
 */
import { describe, expect, it } from "vitest";
import { renderChatSurfaceText } from "./chat-routes";

describe("renderChatSurfaceText", () => {
  it("strips CONFIG card markers from api replies", () => {
    const out = renderChatSurfaceText(
      "You'll want to connect your calendar first.\n\n[CONFIG:owner_finances]",
    );
    expect(out).not.toContain("[CONFIG:");
    expect(out).toContain("connect your calendar first");
  });

  it("renders FOLLOWUPS grammar to plain text instead of leaking the block", () => {
    const out = renderChatSurfaceText(
      "Here's your reminder list.\n\n[FOLLOWUPS]\nnavigate:/apps/reminders=Open reminders\n[/FOLLOWUPS]",
    );
    expect(out).not.toContain("[FOLLOWUPS]");
    expect(out).not.toContain("[/FOLLOWUPS]");
    expect(out).toContain("Here's your reminder list.");
  });

  it("passes plain prose through untouched", () => {
    expect(renderChatSurfaceText("just a normal reply")).toBe(
      "just a normal reply",
    );
  });
});
