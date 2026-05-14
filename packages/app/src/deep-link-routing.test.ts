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
      "lifeops/create",
      new URLSearchParams("text=Water%20plants%20tomorrow"),
      { generateLaunchId: () => "launch-lifeops" },
    );

    expect(hashRoute?.startsWith("#chat?")).toBe(true);
    expect(params(hashRoute ?? "").get("text")).toBe(
      "Water plants tomorrow",
    );
    expect(params(hashRoute ?? "").get("source")).toBe("assistant-entry");
    expect(params(hashRoute ?? "").get("action")).toBe("lifeops.create");
    expect(params(hashRoute ?? "").get("lifeops.section")).toBe("reminders");
    expect(params(hashRoute ?? "").get("assistant.launchId")).toBe(
      "launch-lifeops",
    );
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
