// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  buildAssistantLaunchMetadata,
  clearAssistantLaunchPayloadFromHash,
  readAssistantLaunchPayloadFromHash,
} from "./assistant-launch-payload";

describe("assistant launch payloads", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "http://localhost/");
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
      "http://localhost/#lifeops?text=Call%20mom&source=assistant-entry&action=lifeops.create&assistant.launchId=launch-2&lifeops.section=reminders",
    );

    clearAssistantLaunchPayloadFromHash();

    expect(window.location.href).toBe(
      "http://localhost/#lifeops?lifeops.section=reminders",
    );
  });
});
