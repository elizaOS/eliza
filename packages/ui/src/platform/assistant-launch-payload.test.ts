// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetAssistantLaunchPayloadClaimsForTests,
  buildAssistantLaunchMetadata,
  claimAssistantLaunchPayloadFromHash,
  clearAssistantLaunchPayloadFromHash,
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

    expect(window.location.href).toBe(
      "http://localhost/#lifeops?lifeops.section=reminders",
    );
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
    expect(window.location.href).toBe("http://localhost/#chat");

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
    expect(window.location.href).toContain("assistant.launchId=launch-3");
  });

  it("leaves payload params for a different route consumer", () => {
    window.history.replaceState(
      null,
      "",
      "/#lifeops?text=Open%20brief&source=assistant-entry&action=lifeops.daily-brief&assistant.launchId=launch-4",
    );

    expect(
      claimAssistantLaunchPayloadFromHash(window.location.hash, {
        allowedRoutes: ["chat"],
      }),
    ).toBeNull();
    expect(window.location.href).toBe(
      "http://localhost/#lifeops?text=Open%20brief&source=assistant-entry&action=lifeops.daily-brief&assistant.launchId=launch-4",
    );
  });
});
