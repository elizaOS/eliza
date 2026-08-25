/** Exercises shell-mode parsing, classification, and detached-target resolution. */
import { describe, expect, it } from "vitest";
import { resolveAppShellMode } from "./platform/app-shell-mode";
import {
  isChatOverlayWindowShell,
  isDetachedWindowShell,
  isStandaloneWindowShell,
  parseWindowShellRoute,
  resolveDetachedShellTarget,
} from "./platform/window-shell";

describe("window-shell route classification", () => {
  it("resolves supported app shell modes and falls back to full", () => {
    expect(resolveAppShellMode("?shellMode=voice-workbench", "")).toBe(
      "voice-workbench",
    );
    expect(resolveAppShellMode("?shellMode=full", "")).toBe("full");
  });

  it("parses the chat-overlay shellMode under both param spellings", () => {
    expect(parseWindowShellRoute("?shellMode=chat-overlay")).toEqual({
      mode: "chat-overlay",
    });
    expect(parseWindowShellRoute("?shell-mode=chat-overlay")).toEqual({
      mode: "chat-overlay",
    });
  });

  it("parses settings and surface shells while rejecting obsolete or unknown targets", () => {
    expect(parseWindowShellRoute("")).toEqual({ mode: "main" });
    expect(parseWindowShellRoute("?shell=settings&tab=cloud")).toEqual({
      mode: "settings",
      tab: "cloud",
    });
    expect(parseWindowShellRoute("?shell=surface&tab=browser")).toEqual({
      mode: "surface",
      tab: "browser",
    });
    expect(parseWindowShellRoute("?shell=pill")).toEqual({ mode: "main" });
    expect(parseWindowShellRoute("?shell=surface&tab=bogus")).toEqual({
      mode: "main",
    });
  });

  it("classifies chat-overlay as standalone but not detached", () => {
    const route = parseWindowShellRoute("?shellMode=chat-overlay");
    expect(isChatOverlayWindowShell(route)).toBe(true);
    expect(isStandaloneWindowShell(route)).toBe(true);
    expect(isDetachedWindowShell(route)).toBe(false);
  });

  it("treats the main shell as neither standalone nor chat-overlay", () => {
    const route = parseWindowShellRoute("");
    expect(isStandaloneWindowShell(route)).toBe(false);
    expect(isChatOverlayWindowShell(route)).toBe(false);
    expect(isDetachedWindowShell(route)).toBe(false);
  });

  it("maps detached surface routes to a target and refuses non-detached ones", () => {
    expect(
      resolveDetachedShellTarget(
        parseWindowShellRoute("?shell=surface&tab=release"),
      ),
    ).toEqual({ tab: "settings", settingsSection: "updates" });
    expect(() =>
      resolveDetachedShellTarget(
        parseWindowShellRoute("?shellMode=chat-overlay"),
      ),
    ).toThrow();
    expect(() =>
      resolveDetachedShellTarget(parseWindowShellRoute("")),
    ).toThrow();
  });
});
