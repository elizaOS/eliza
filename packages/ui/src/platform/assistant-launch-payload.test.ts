// @vitest-environment jsdom

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

  it("clears stale LifeOps surface params after chat consumes a create launch", () => {
    window.history.replaceState(
      null,
      "",
      "/#chat?text=Create%20a%20task&source=assistant-entry&action=lifeops.create&assistant.launchId=launch-4&lifeops.section=reminders",
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
    expect(window.location.hash).toBe("#chat");
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
