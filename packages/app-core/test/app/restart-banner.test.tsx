import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface RestartBannerContextStub {
  t: (key: string) => string;
  pendingRestart: boolean;
  pendingRestartReasons: string[];
  restartBannerDismissed: boolean;
  dismissRestartBanner: () => void;
  showRestartBanner: () => void;
  triggerRestart: () => Promise<void>;
  relaunchDesktop: () => Promise<void>;
}

const mockUseApp = vi.fn<() => RestartBannerContextStub>();

vi.mock("@elizaos/app-core/state", async () => {
  const actual = await vi.importActual<
    typeof import("@elizaos/app-core/state")
  >("@elizaos/app-core/state");
  return {
    ...actual,
    useApp: () => mockUseApp(),
  };
});

import { RestartBanner } from "@elizaos/app-core/components";

function makeContext(
  overrides: Partial<RestartBannerContextStub> = {},
): RestartBannerContextStub {
  return {
    t: (k: string) => k,
    pendingRestart: false,
    pendingRestartReasons: [],
    restartBannerDismissed: false,
    dismissRestartBanner: vi.fn(),
    showRestartBanner: vi.fn(),
    triggerRestart: vi.fn(async () => undefined),
    relaunchDesktop: vi.fn(async () => undefined),
    ...overrides,
  };
}

/** Extract visible text from HTML markup (strip tags). */
function readAllText(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("RestartBanner", () => {
  beforeEach(() => {
    mockUseApp.mockReset();
  });

  it("renders nothing when no restart is pending", () => {
    mockUseApp.mockReturnValue(makeContext({ pendingRestart: false }));

    const markup = renderToStaticMarkup(React.createElement(RestartBanner));
    expect(markup).toBe("");
  });

  it("renders compact reminder when banner is dismissed", () => {
    mockUseApp.mockReturnValue(
      makeContext({
        pendingRestart: true,
        pendingRestartReasons: ["Configuration updated"],
        restartBannerDismissed: true,
      }),
    );

    const markup = renderToStaticMarkup(React.createElement(RestartBanner));
    const text = readAllText(markup);
    expect(text).toContain("Configuration updated");
    expect(text).toContain("Electrobun still has restart-required changes queued");
    expect(markup).toContain("Review");
  });

  it("renders banner with single reason text", () => {
    mockUseApp.mockReturnValue(
      makeContext({
        pendingRestart: true,
        pendingRestartReasons: ["Plugin toggled"],
      }),
    );

    const markup = renderToStaticMarkup(React.createElement(RestartBanner));
    const text = readAllText(markup);

    expect(text).toContain("Plugin toggled");
    expect(text).toContain("restart to apply");
  });

  it("renders banner with count for multiple reasons", () => {
    mockUseApp.mockReturnValue(
      makeContext({
        pendingRestart: true,
        pendingRestartReasons: [
          "Plugin toggled",
          "Configuration updated",
          "Wallet configuration updated",
        ],
      }),
    );

    const markup = renderToStaticMarkup(React.createElement(RestartBanner));
    const text = readAllText(markup);

    expect(text).toContain("3 changes pending");
    expect(text).toContain("restart to apply");
  });

  it("renders Later button", () => {
    mockUseApp.mockReturnValue(
      makeContext({
        pendingRestart: true,
        pendingRestartReasons: ["Plugin toggled"],
      }),
    );

    const markup = renderToStaticMarkup(React.createElement(RestartBanner));
    expect(markup).toContain("Later");
  });

  it("renders Restart Now button", () => {
    mockUseApp.mockReturnValue(
      makeContext({
        pendingRestart: true,
        pendingRestartReasons: ["Plugin toggled"],
      }),
    );

    const markup = renderToStaticMarkup(React.createElement(RestartBanner));
    expect(markup).toContain("Restart Now");
  });

  it("renders with amber background styling", () => {
    mockUseApp.mockReturnValue(
      makeContext({
        pendingRestart: true,
        pendingRestartReasons: ["Configuration updated"],
      }),
    );

    const markup = renderToStaticMarkup(React.createElement(RestartBanner));
    expect(markup).toContain(
      "color-mix(in srgb, var(--accent) 15%, var(--bg) 85%)",
    );
    expect(markup).toContain("z-[9998]");
  });

  it("renders with zero reasons gracefully (edge case: pendingRestart true but empty reasons)", () => {
    mockUseApp.mockReturnValue(
      makeContext({
        pendingRestart: true,
        pendingRestartReasons: [],
      }),
    );

    const markup = renderToStaticMarkup(React.createElement(RestartBanner));
    const text = readAllText(markup);

    // Should still render with fallback text
    expect(text).toContain("Restart required to apply changes");
  });

  it("dismiss-then-re-show: compact when dismissed, expands with new reasons", () => {
    // Step 1: Banner is compact after user clicks "Later"
    mockUseApp.mockReturnValue(
      makeContext({
        pendingRestart: true,
        pendingRestartReasons: ["Plugin toggled"],
        restartBannerDismissed: true,
      }),
    );

    const dismissedMarkup = renderToStaticMarkup(
      React.createElement(RestartBanner),
    );
    expect(dismissedMarkup).not.toBe("");
    expect(readAllText(dismissedMarkup)).toContain("Review");

    // Step 2: A new config change arrives — restartBannerDismissed is reset
    // to false by the WS handler (simulating AppContext behavior)
    mockUseApp.mockReturnValue(
      makeContext({
        pendingRestart: true,
        pendingRestartReasons: ["Plugin toggled", "Configuration updated"],
        restartBannerDismissed: false,
      }),
    );

    const reshownMarkup = renderToStaticMarkup(
      React.createElement(RestartBanner),
    );
    const text = readAllText(reshownMarkup);

    expect(reshownMarkup).not.toBe("");
    expect(text).toContain("2 changes pending");
    expect(text).toContain("restart to apply");
  });
});
