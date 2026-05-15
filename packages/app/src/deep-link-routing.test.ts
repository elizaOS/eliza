import { describe, expect, it } from "vitest";
import { buildAssistantLaunchHashRoute } from "./deep-link-routing";

function params(hashRoute: string): URLSearchParams {
  return new URLSearchParams(hashRoute.split("?")[1] ?? "");
}

describe("assistant launch deep-link routing", () => {
  it("routes ask links through chat with trusted assistant source metadata", () => {
    const hashRoute = buildAssistantLaunchHashRoute(
      "ask",
      new URLSearchParams("text=Remind%20me%20at%205"),
      { generateLaunchId: () => "launch-ask" },
    );

    expect(hashRoute?.startsWith("#chat?")).toBe(true);
    expect(params(hashRoute ?? "").get("text")).toBe("Remind me at 5");
    expect(params(hashRoute ?? "").get("source")).toBe("assistant-entry");
    expect(params(hashRoute ?? "").get("action")).toBe("ask");
    expect(params(hashRoute ?? "").get("assistant.launchId")).toBe(
      "launch-ask",
    );
  });

  it("defaults chat links to the trusted assistant source so text is consumable", () => {
    const hashRoute = buildAssistantLaunchHashRoute(
      "chat",
      new URLSearchParams("text=Summarize%20today"),
      { generateLaunchId: () => "launch-chat" },
    );

    expect(hashRoute?.startsWith("#chat?")).toBe(true);
    expect(params(hashRoute ?? "").get("source")).toBe("assistant-entry");
    expect(params(hashRoute ?? "").get("action")).toBe("chat");
    expect(params(hashRoute ?? "").get("assistant.launchId")).toBe(
      "launch-chat",
    );
  });

  it("routes LifeOps create text into chat/planner, not a native task path", () => {
    const hashRoute = buildAssistantLaunchHashRoute(
      "lifeops/task/new",
      new URLSearchParams("text=Water%20plants%20tomorrow"),
      { generateLaunchId: () => "launch-lifeops" },
    );

    expect(hashRoute?.startsWith("#chat?")).toBe(true);
    expect(params(hashRoute ?? "").get("text")).toBe("Water plants tomorrow");
    expect(params(hashRoute ?? "").get("source")).toBe("assistant-entry");
    expect(params(hashRoute ?? "").get("action")).toBe("lifeops.create");
    expect(params(hashRoute ?? "").get("lifeops.section")).toBeNull();
    expect(params(hashRoute ?? "").get("assistant.launchId")).toBe(
      "launch-lifeops",
    );
  });

  it("preserves macOS Shortcuts source and action on assistant links", () => {
    const hashRoute = buildAssistantLaunchHashRoute(
      "assistant",
      new URLSearchParams(
        "text=Water%20plants%20tomorrow&source=macos-shortcuts&action=lifeops.create",
      ),
      { generateLaunchId: () => "launch-macos-shortcuts" },
    );

    expect(hashRoute?.startsWith("#chat?")).toBe(true);
    expect(params(hashRoute ?? "").get("source")).toBe("macos-shortcuts");
    expect(params(hashRoute ?? "").get("action")).toBe("lifeops.create");
    expect(params(hashRoute ?? "").get("assistant.launchId")).toBe(
      "launch-macos-shortcuts",
    );
    expect(params(hashRoute ?? "").get("lifeops.section")).toBeNull();
  });

  it("routes Android feature-open inventory to voice chat", () => {
    const hashRoute = buildAssistantLaunchHashRoute(
      "feature/open",
      new URLSearchParams(
        "source=android-app-actions&feature=eliza_app_action_voice",
      ),
      { generateLaunchId: () => "launch-voice" },
    );

    expect(hashRoute?.startsWith("#chat?")).toBe(true);
    expect(params(hashRoute ?? "").get("source")).toBe("android-app-actions");
    expect(params(hashRoute ?? "").get("voice")).toBe("1");
    expect(params(hashRoute ?? "").get("assistant.launchId")).toBe(
      "launch-voice",
    );
  });

  it("routes Android feature-open inventory to LifeOps daily brief", () => {
    const hashRoute = buildAssistantLaunchHashRoute(
      "feature/open",
      new URLSearchParams("source=android-app-actions&feature=daily%20brief"),
      { generateLaunchId: () => "launch-brief" },
    );

    expect(hashRoute?.startsWith("#lifeops?")).toBe(true);
    expect(params(hashRoute ?? "").get("source")).toBe("android-app-actions");
    expect(params(hashRoute ?? "").get("action")).toBe("lifeops.daily-brief");
    expect(params(hashRoute ?? "").get("lifeops.section")).toBe("overview");
  });

  it("routes Android feature-open task inventory into LifeOps reminders", () => {
    const hashRoute = buildAssistantLaunchHashRoute(
      "feature/open",
      new URLSearchParams("source=android-app-actions&feature=tasks"),
      { generateLaunchId: () => "launch-tasks" },
    );

    expect(hashRoute?.startsWith("#lifeops?")).toBe(true);
    expect(params(hashRoute ?? "").get("source")).toBe("android-app-actions");
    expect(params(hashRoute ?? "").get("action")).toBe("lifeops.tasks");
    expect(params(hashRoute ?? "").get("lifeops.section")).toBe("reminders");
  });

  it("opens LifeOps reminders when create links do not carry text", () => {
    const hashRoute = buildAssistantLaunchHashRoute(
      "lifeops/create",
      new URLSearchParams(),
      { generateLaunchId: () => "launch-lifeops-empty" },
    );

    expect(hashRoute?.startsWith("#lifeops?")).toBe(true);
    expect(params(hashRoute ?? "").get("action")).toBe("lifeops.create");
    expect(params(hashRoute ?? "").get("lifeops.section")).toBe("reminders");
  });
});
