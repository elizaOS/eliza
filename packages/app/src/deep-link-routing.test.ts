import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildAssistantLaunchHashRoute,
  resolveDeepLinkNavigationIntent,
} from "./deep-link-routing";

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

  it("routes iOS App Intent smart replies through chat with source metadata", () => {
    const hashRoute = buildAssistantLaunchHashRoute(
      "chat/smart-reply",
      new URLSearchParams(
        "text=Can%20you%20send%20me%20the%20deck%3F&source=ios-app-intents",
      ),
      { generateLaunchId: () => "launch-smart-reply" },
    );

    expect(hashRoute?.startsWith("#chat?")).toBe(true);
    expect(params(hashRoute ?? "").get("source")).toBe("ios-app-intents");
    expect(params(hashRoute ?? "").get("action")).toBe("smart-reply");
    expect(params(hashRoute ?? "").get("assistant.launchId")).toBe(
      "launch-smart-reply",
    );
  });

  it("routes Android Share Sheet smart replies through chat with source metadata", () => {
    const hashRoute = buildAssistantLaunchHashRoute(
      "chat",
      new URLSearchParams(
        "text=Could%20you%20review%20this%3F&source=android-share-sheet&action=smart-reply",
      ),
      { generateLaunchId: () => "launch-android-share" },
    );

    expect(hashRoute?.startsWith("#chat?")).toBe(true);
    expect(params(hashRoute ?? "").get("source")).toBe("android-share-sheet");
    expect(params(hashRoute ?? "").get("action")).toBe("smart-reply");
    expect(params(hashRoute ?? "").get("assistant.launchId")).toBe(
      "launch-android-share",
    );
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

  it("routes Android widget daily brief links into chat with a planner hint", () => {
    const hashRoute = buildAssistantLaunchHashRoute(
      "lifeops/daily-brief",
      new URLSearchParams("source=android-widget&action=lifeops.daily-brief"),
      { generateLaunchId: () => "launch-android-widget" },
    );

    expect(hashRoute?.startsWith("#chat?")).toBe(true);
    expect(params(hashRoute ?? "").get("source")).toBe("android-widget");
    expect(params(hashRoute ?? "").get("action")).toBe("lifeops.daily-brief");
    expect(params(hashRoute ?? "").get("lifeops.section")).toBeNull();
    expect(params(hashRoute ?? "").get("assistant.launchId")).toBe(
      "launch-android-widget",
    );
  });

  it("routes Android feature-open inventory to chat with a daily-brief hint", () => {
    const hashRoute = buildAssistantLaunchHashRoute(
      "feature/open",
      new URLSearchParams("source=android-app-actions&feature=daily%20brief"),
      { generateLaunchId: () => "launch-brief" },
    );

    expect(hashRoute?.startsWith("#chat?")).toBe(true);
    expect(params(hashRoute ?? "").get("source")).toBe("android-app-actions");
    expect(params(hashRoute ?? "").get("action")).toBe("lifeops.daily-brief");
    expect(params(hashRoute ?? "").get("lifeops.section")).toBeNull();
  });

  it("routes Android feature-open task inventory into chat with a tasks hint", () => {
    const hashRoute = buildAssistantLaunchHashRoute(
      "feature/open",
      new URLSearchParams("source=android-app-actions&feature=tasks"),
      { generateLaunchId: () => "launch-tasks" },
    );

    expect(hashRoute?.startsWith("#chat?")).toBe(true);
    expect(params(hashRoute ?? "").get("source")).toBe("android-app-actions");
    expect(params(hashRoute ?? "").get("action")).toBe("lifeops.tasks");
    expect(params(hashRoute ?? "").get("lifeops.section")).toBeNull();
  });

  it("routes text-free create links into chat with a create hint", () => {
    const hashRoute = buildAssistantLaunchHashRoute(
      "lifeops/create",
      new URLSearchParams(),
      { generateLaunchId: () => "launch-lifeops-empty" },
    );

    expect(hashRoute?.startsWith("#chat?")).toBe(true);
    expect(params(hashRoute ?? "").get("action")).toBe("lifeops.create");
    expect(params(hashRoute ?? "").get("lifeops.section")).toBeNull();
  });

  it("fuzzes arbitrary assistant entry query strings without throwing or producing unsafe routes", () => {
    const knownPaths = [
      "feature/open",
      "ask",
      "assistant",
      "chat/ask",
      "smart-reply",
      "chat/smart-reply",
      "chat",
      "voice",
      "chat/voice",
      "daily-brief",
      "lifeops/daily-brief",
      "lifeops/tasks",
      "lifeops/create",
      "lifeops/task",
      "lifeops/task/new",
      "lifeops/reminder",
    ] as const;
    const keys = [
      "text",
      "q",
      "query",
      "body",
      "source",
      "action",
      "feature",
      "lifeops.section",
      "assistant.launchId",
      "redirect",
    ] as const;

    fc.assert(
      fc.property(
        fc.constantFrom(...knownPaths),
        fc.array(
          fc.tuple(fc.constantFrom(...keys), fc.string({ maxLength: 80 })),
          { maxLength: 16 },
        ),
        (path, entries) => {
          const searchParams = new URLSearchParams();
          for (const [key, value] of entries) {
            searchParams.append(key, value);
          }

          const hashRoute = buildAssistantLaunchHashRoute(path, searchParams, {
            generateLaunchId: () => "launch-fuzz",
          });

          expect(hashRoute).not.toBeNull();
          expect(hashRoute).toMatch(/^#chat(?:\?|$)/);
          expect(hashRoute).not.toContain("javascript:");
          expect(hashRoute).not.toContain("\n");
          expect(hashRoute).not.toContain("\r");
        },
      ),
      { numRuns: 500 },
    );
  });

  it("fuzzes unknown deep-link paths as non-routable instead of falling through to chat", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (path) => {
        fc.pre(
          ![
            "feature/open",
            "ask",
            "assistant",
            "chat/ask",
            "smart-reply",
            "chat/smart-reply",
            "chat",
            "voice",
            "chat/voice",
            "daily-brief",
            "lifeops/daily-brief",
            "lifeops/tasks",
            "lifeops/create",
            "lifeops/task",
            "lifeops/task/new",
            "lifeops/reminder",
          ].includes(path),
        );

        expect(
          buildAssistantLaunchHashRoute(
            path,
            new URLSearchParams("text=hello&source=attacker"),
            { generateLaunchId: () => "launch-unknown" },
          ),
        ).toBeNull();
      }),
      { numRuns: 500 },
    );
  });
});

describe("top-level-surface deep-link navigation intents", () => {
  it("routes a settings deep link to the settings tab", () => {
    expect(resolveDeepLinkNavigationIntent("settings")).toEqual({
      viewId: "settings",
      viewPath: "/settings",
    });
  });

  it("routes a wallet deep link to the inventory tab (/wallet)", () => {
    expect(resolveDeepLinkNavigationIntent("wallet")).toEqual({
      viewId: "inventory",
      viewPath: "/wallet",
    });
  });

  it("treats the inventory alias like wallet", () => {
    expect(resolveDeepLinkNavigationIntent("inventory")).toEqual({
      viewId: "inventory",
      viewPath: "/wallet",
    });
  });

  it("routes a browser deep link to the browser tab", () => {
    expect(resolveDeepLinkNavigationIntent("browser")).toEqual({
      viewId: "browser",
      viewPath: "/browser",
    });
  });

  it("routes apps/deploy to the cloud-apps studio page (#10823 Apps Deploy UI entry)", () => {
    expect(resolveDeepLinkNavigationIntent("apps/deploy")).toEqual({
      viewId: "cloud-apps",
      viewPath: "/cloud-apps",
    });
  });

  it("treats the cloud-apps page id as an alias for the Apps Deploy studio", () => {
    expect(resolveDeepLinkNavigationIntent("cloud-apps")).toEqual({
      viewId: "cloud-apps",
      viewPath: "/cloud-apps",
    });
  });

  it("does NOT claim the installed-apps or nested app-slug paths for the studio", () => {
    expect(resolveDeepLinkNavigationIntent("apps")).toBeNull();
    expect(resolveDeepLinkNavigationIntent("apps/files")).toBeNull();
    expect(resolveDeepLinkNavigationIntent("apps/deploy/extra")).toBeNull();
  });

  it("routes a bare connectors deep link to Settings → Connectors", () => {
    expect(resolveDeepLinkNavigationIntent("connectors")).toEqual({
      viewId: "settings",
      viewPath: "/settings",
      subview: "connectors",
    });
  });

  it("routes a per-provider connectors deep link to Settings → Connectors", () => {
    expect(
      resolveDeepLinkNavigationIntent("settings/connectors/discord"),
    ).toEqual({
      viewId: "settings",
      viewPath: "/settings",
      subview: "connectors",
    });
  });

  it("returns null for chat-launch and unknown paths (handled elsewhere)", () => {
    expect(resolveDeepLinkNavigationIntent("chat")).toBeNull();
    expect(resolveDeepLinkNavigationIntent("ask")).toBeNull();
    expect(resolveDeepLinkNavigationIntent("share")).toBeNull();
    expect(resolveDeepLinkNavigationIntent("connect")).toBeNull();
    expect(resolveDeepLinkNavigationIntent("totally-unknown")).toBeNull();
  });
});
