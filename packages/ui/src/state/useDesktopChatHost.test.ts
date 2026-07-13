/**
 * Pure host-resolution rule for the desktop "one chat, in the active window"
 * coordinator (#16200 Stage 3): which window renders the singular ChatOverlay.
 */
import { describe, expect, it } from "vitest";
import { resolveIsChatHost } from "./useDesktopChatHost";

describe("resolveIsChatHost", () => {
  it("always renders off the desktop shell (one window, no host signal)", () => {
    expect(resolveIsChatHost(null, null, false)).toBe(true);
    expect(resolveIsChatHost(7, 3, false)).toBe(true);
  });

  it("renders in every window until the first host broadcast (host null)", () => {
    // Default-show so the main window's chat is never briefly blank at startup.
    expect(resolveIsChatHost(null, 1, true)).toBe(true);
  });

  it("renders only in the host window once the shell has broadcast", () => {
    // Window 5 is the active host: it shows, window 2 hides.
    expect(resolveIsChatHost(5, 5, true)).toBe(true);
    expect(resolveIsChatHost(5, 2, true)).toBe(false);
  });

  it("falls back to showing when this window has no id on desktop", () => {
    expect(resolveIsChatHost(5, null, true)).toBe(true);
  });
});
