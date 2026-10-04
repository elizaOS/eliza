// @vitest-environment jsdom

import { resolveSurfaceManifest } from "@elizaos/core/protocol";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SurfaceRealmScope,
  setActiveSurfaceRealmScope,
} from "../../surface-realm-broker";
import { SubscriptionStatus } from "./SubscriptionStatus";

vi.mock("../../state/app-store", () => ({
  useAppSelector: (
    select: (state: { t: (key: string) => string }) => unknown,
  ) => select({ t: (key: string) => key }),
}));
vi.mock("../../utils/openExternalUrl", () => ({
  preOpenWindow: () => ({ close: () => undefined }),
  navigatePreOpenedWindow: () => true,
}));
vi.mock("../../api/client", () => ({
  client: {
    startAnthropicLogin: vi.fn(async () => ({
      authUrl: "https://claude.ai/oauth/authorize?x=1",
    })),
  },
}));

const props = {
  resolvedSelectedId: "anthropic-subscription",
  subscriptionStatus: [],
  anthropicConnected: false,
  setAnthropicConnected: () => undefined,
  anthropicCliDetected: false,
  subscriptionDisconnecting: null,
  handleSelectSubscription: async () => undefined,
  loadSubscriptionStatus: async () => undefined,
} as unknown as ComponentProps<typeof SubscriptionStatus>;

const PASTE_CODE_PLACEHOLDER = "subscriptionstatus.PasteTheAuthorizat";

describe("SubscriptionStatus Anthropic OAuth", () => {
  afterEach(() => {
    cleanup();
    setActiveSurfaceRealmScope(null);
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("keeps the pending paste-code form across a remount inside the settings view scope", async () => {
    setActiveSurfaceRealmScope(
      new SurfaceRealmScope(
        resolveSurfaceManifest({ surface: { capabilities: [] } }),
        "settings",
        window.localStorage,
        () => undefined,
      ),
    );
    const first = render(<SubscriptionStatus {...props} />);
    fireEvent.click(screen.getByText("settings.subscription.oauthLogin"));
    await act(async () => {
      fireEvent.click(
        screen.getByText("settings.subscription.loginWithAnthropic"),
      );
    });
    expect(
      screen.queryByPlaceholderText(PASTE_CODE_PLACEHOLDER),
    ).not.toBeNull();

    first.unmount();
    render(<SubscriptionStatus {...props} />);

    expect(
      screen.queryByPlaceholderText(PASTE_CODE_PLACEHOLDER),
    ).not.toBeNull();
    expect(new URL(window.location.href).searchParams.get("setup")).toBe(
      "oauth",
    );
  });
});
