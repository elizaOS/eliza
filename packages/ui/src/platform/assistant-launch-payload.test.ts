// @vitest-environment jsdom

/**
 * Covers assistant launch payloads: reading text/source/action/id out of a
 * `#chat?…` hash route, building launch metadata, and the claim/consume/clear
 * single-use lifecycle keyed on the hash. Reads/writes window.history under jsdom.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetAssistantLaunchPayloadClaimsForTests,
  buildAssistantLaunchMetadata,
  claimAssistantLaunchPayloadFromHash,
  clearAssistantLaunchPayloadFromHash,
  consumeAssistantLaunchPayloadFromHash,
  readAssistantLaunchPayloadFromHash,
} from "./assistant-launch-payload";

describe("assistant launch payloads", () => {
  beforeEach(() => {
    __resetAssistantLaunchPayloadClaimsForTests();
    window.history.replaceState(null, "", "/");
  });

  it("reads assistant launch text, source, action, and id from hash routes", () => {
    const payload = readAssistantLaunchPayloadFromHash(
      "#chat?text=Remind%20me%20at%205&source=assistant-entry&action=ask&assistant.launchId=launch-1",
    );

    expect(payload).toEqual({
      action: "ask",
      launchId: "launch-1",
      route: "chat",
      source: "assistant-entry",
      text: "Remind me at 5",
      voice: false,
      transcribe: false,
    });
    expect(
      payload ? buildAssistantLaunchMetadata(payload) : null,
    ).toMatchObject({
      assistantLaunch: true,
      assistantLaunchAction: "ask",
      assistantLaunchId: "launch-1",
      assistantLaunchRoute: "chat",
      assistantLaunchSource: "assistant-entry",
    });
  });

  it("trusts macOS Shortcuts assistant launches", () => {
    expect(
      readAssistantLaunchPayloadFromHash(
        "#chat?text=Water%20plants&source=macos-shortcuts&action=lifeops.create&assistant.launchId=launch-macos",
      ),
    ).toMatchObject({
      action: "lifeops.create",
      launchId: "launch-macos",
      route: "chat",
      source: "macos-shortcuts",
      text: "Water plants",
    });
  });

  it("ignores untrusted sources and empty text", () => {
    expect(
      readAssistantLaunchPayloadFromHash(
        "#chat?text=hello&source=unknown-shortcut",
      ),
    ).toBeNull();
    expect(
      readAssistantLaunchPayloadFromHash("#chat?source=assistant-entry"),
    ).toBeNull();
    // Capture flags do not bypass the trusted-source gate.
    expect(
      readAssistantLaunchPayloadFromHash(
        "#chat?voice=1&source=unknown-shortcut",
      ),
    ).toBeNull();
  });

  it("accepts text-less voice launches from every OS shortcut source", () => {
    // The exact URLs the iOS intents/controls/widgets and Android surfaces
    // mint (via deep-link routing) — a voice launch carries no text.
    for (const source of [
      "ios-app-intents",
      "ios-control",
      "ios-widget",
      "ios-live-activity",
      "android-app-actions",
      "android-qs-tile",
      "desktop-hotkey",
      "desktop-tray",
    ]) {
      const payload = readAssistantLaunchPayloadFromHash(
        `#chat?voice=1&source=${source}&assistant.launchId=voice-${source}`,
      );
      expect(payload).toMatchObject({
        launchId: `voice-${source}`,
        route: "chat",
        source,
        text: "",
        voice: true,
        transcribe: false,
      });
    }
  });

  it("accepts text-less transcribe launches and separates fallback ids", () => {
    expect(
      readAssistantLaunchPayloadFromHash(
        "#chat?transcribe=1&source=ios-app-intents&assistant.launchId=t-1",
      ),
    ).toMatchObject({ transcribe: true, voice: false, text: "" });
    // Without an explicit launchId, a voice launch must not collide with a
    // text launch's fallback id from the same source.
    const voicePayload = readAssistantLaunchPayloadFromHash(
      "#chat?voice=1&source=assistant-entry",
    );
    const transcribePayload = readAssistantLaunchPayloadFromHash(
      "#chat?transcribe=1&source=assistant-entry",
    );
    expect(voicePayload?.launchId).not.toBe(transcribePayload?.launchId);
  });

  it("claims a voice launch once and clears the capture flag from the hash", () => {
    window.history.replaceState(
      null,
      "",
      "/#chat?voice=1&source=ios-app-intents&assistant.launchId=voice-once",
    );

    const claimed = claimAssistantLaunchPayloadFromHash(window.location.hash, {
      allowedRoutes: ["chat"],
    });
    expect(claimed).toMatchObject({ voice: true, text: "" });
    expect(window.location.hash).toBe("#chat");

    window.history.replaceState(
      null,
      "",
      "/#chat?voice=1&source=ios-app-intents&assistant.launchId=voice-once",
    );
    expect(
      claimAssistantLaunchPayloadFromHash(window.location.hash, {
        allowedRoutes: ["chat"],
      }),
    ).toBeNull();
  });

  it("consumes a capture-only launch without sending", async () => {
    window.history.replaceState(
      null,
      "",
      "/#chat?voice=1&source=android-qs-tile&assistant.launchId=voice-consume",
    );
    const sendText = vi.fn().mockResolvedValue(undefined);

    const consumed = await consumeAssistantLaunchPayloadFromHash(
      window.location.hash,
      { allowedRoutes: ["chat"], sendText },
    );

    expect(consumed).toMatchObject({ voice: true, text: "" });
    expect(sendText).not.toHaveBeenCalled();
  });

  it("clears payload params while preserving surface params", () => {
    window.history.replaceState(
      null,
      "",
      "/#lifeops?text=Call%20mom&source=assistant-entry&action=lifeops.create&assistant.launchId=launch-2&lifeops.section=reminders",
    );

    clearAssistantLaunchPayloadFromHash();

    expect(window.location.hash).toBe("#lifeops?lifeops.section=reminders");
  });

  it("claims a trusted launch payload only once and clears the URL", () => {
    window.history.replaceState(
      null,
      "",
      "/#chat?text=Create%20a%20task&source=assistant-entry&action=lifeops.create&assistant.launchId=launch-3",
    );

    const claimed = claimAssistantLaunchPayloadFromHash(window.location.hash, {
      allowedRoutes: ["chat"],
    });

    expect(claimed).toMatchObject({
      action: "lifeops.create",
      launchId: "launch-3",
      route: "chat",
      source: "assistant-entry",
      text: "Create a task",
    });
    expect(window.location.hash).toBe("#chat");

    window.history.replaceState(
      null,
      "",
      "/#chat?text=Create%20a%20task&source=assistant-entry&action=lifeops.create&assistant.launchId=launch-3",
    );

    expect(
      claimAssistantLaunchPayloadFromHash(window.location.hash, {
        allowedRoutes: ["chat"],
      }),
    ).toBeNull();
    expect(window.location.hash).toContain("assistant.launchId=launch-3");
  });

  it("clears payload params but preserves unrelated surface params on chat", () => {
    window.history.replaceState(
      null,
      "",
      "/#chat?text=Create%20a%20task&source=assistant-entry&action=lifeops.create&assistant.launchId=launch-4&surface=reminders",
    );

    expect(
      claimAssistantLaunchPayloadFromHash(window.location.hash, {
        allowedRoutes: ["chat"],
      }),
    ).toMatchObject({
      action: "lifeops.create",
      launchId: "launch-4",
      route: "chat",
      source: "assistant-entry",
      text: "Create a task",
    });
    expect(window.location.hash).toBe("#chat?surface=reminders");
  });

  it("leaves payload params for a different route consumer", () => {
    window.history.replaceState(
      null,
      "",
      "/#lifeops?text=Open%20brief&source=assistant-entry&action=lifeops.daily-brief&assistant.launchId=launch-5",
    );

    expect(
      claimAssistantLaunchPayloadFromHash(window.location.hash, {
        allowedRoutes: ["chat"],
      }),
    ).toBeNull();
    expect(window.location.hash).toBe(
      "#lifeops?text=Open%20brief&source=assistant-entry&action=lifeops.daily-brief&assistant.launchId=launch-5",
    );
  });

  it("consumes a trusted launch by sending text with assistant metadata", async () => {
    window.history.replaceState(
      null,
      "",
      "/#chat?text=Summarize%20today&source=assistant-entry&action=chat&assistant.launchId=launch-6",
    );
    const sendText = vi.fn().mockResolvedValue(undefined);

    const consumed = await consumeAssistantLaunchPayloadFromHash(
      window.location.hash,
      {
        allowedRoutes: ["chat"],
        sendText,
      },
    );

    expect(consumed).toMatchObject({
      action: "chat",
      launchId: "launch-6",
      route: "chat",
      source: "assistant-entry",
      text: "Summarize today",
    });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("Summarize today", {
      metadata: {
        assistantLaunch: true,
        assistantLaunchAction: "chat",
        assistantLaunchId: "launch-6",
        assistantLaunchRoute: "chat",
        assistantLaunchSource: "assistant-entry",
      },
    });
    expect(window.location.hash).toBe("#chat");

    await consumeAssistantLaunchPayloadFromHash(window.location.hash, {
      allowedRoutes: ["chat"],
      sendText,
    });
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("falls back with the claimed payload when launch send fails", async () => {
    window.history.replaceState(
      null,
      "",
      "/#chat?text=Try%20again&source=assistant-entry&action=ask&assistant.launchId=launch-7",
    );
    const error = new Error("send failed");
    const sendText = vi.fn().mockRejectedValue(error);
    const onSendFailure = vi.fn();

    const consumed = await consumeAssistantLaunchPayloadFromHash(
      window.location.hash,
      {
        allowedRoutes: ["chat"],
        onSendFailure,
        sendText,
      },
    );

    expect(consumed?.launchId).toBe("launch-7");
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(onSendFailure).toHaveBeenCalledTimes(1);
    expect(onSendFailure).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Try again" }),
      error,
    );
    expect(window.location.hash).toBe("#chat");
  });
});
