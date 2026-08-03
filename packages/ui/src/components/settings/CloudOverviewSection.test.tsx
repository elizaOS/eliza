// @vitest-environment jsdom
/**
 * Covers the Cloud overview's login launch and account escape hatch. Desktop
 * login preserves the popup handle for the auth handoff, while connected mobile
 * users retain the same inline sign-out path as the desktop account menu.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __setAppValueForTests } from "../../state/app-store";
import { CloudOverviewSection } from "./CloudOverviewSection";

const cloudLoginWindow = vi.hoisted(() => ({
  popup: { closed: false } as unknown as Window,
  preOpen: vi.fn(),
}));

vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({ ref: null, agentProps: {} }),
}));

vi.mock("../../state/cloud-login-launch", () => ({
  preOpenCloudLoginWindow: cloudLoginWindow.preOpen,
}));

function t(_key: string, opts?: { defaultValue?: string; id?: string }) {
  return (opts?.defaultValue ?? _key).replace("{{id}}", opts?.id ?? "");
}

function seedCloudOverviewState(
  overrides: Partial<{
    elizaCloudConnected: boolean;
    elizaCloudDisconnecting: boolean;
    elizaCloudLoginBusy: boolean;
    elizaCloudUserId: string | null;
    handleCloudDisconnect: () => Promise<void>;
    handleInteractiveCloudLogin: (options?: unknown) => Promise<void>;
    handleCloudSignOut: () => Promise<void>;
  }> = {},
) {
  __setAppValueForTests({
    t,
    elizaCloudConnected: overrides.elizaCloudConnected ?? false,
    elizaCloudDisconnecting: overrides.elizaCloudDisconnecting ?? false,
    elizaCloudLoginBusy: overrides.elizaCloudLoginBusy ?? false,
    elizaCloudUserId: overrides.elizaCloudUserId ?? null,
    handleCloudDisconnect:
      overrides.handleCloudDisconnect ?? vi.fn(async () => undefined),
    handleInteractiveCloudLogin:
      overrides.handleInteractiveCloudLogin ?? vi.fn(async () => undefined),
    handleCloudSignOut:
      overrides.handleCloudSignOut ?? vi.fn(async () => undefined),
    setActionNotice: vi.fn(),
  } as never);
}

afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
  vi.clearAllMocks();
  cloudLoginWindow.preOpen.mockReturnValue(cloudLoginWindow.popup);
});

describe("CloudOverviewSection", () => {
  it("invokes the interactive login entry point and does not pre-open the window itself", () => {
    const handleInteractiveCloudLogin = vi.fn(async () => undefined);
    seedCloudOverviewState({ handleInteractiveCloudLogin });

    render(<CloudOverviewSection />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Cloud" }));

    // #17129: the interactive entry point owns popup pre-opening. The
    // component must call the entry point and must NOT call the raw
    // pre-open/window path itself.
    expect(handleInteractiveCloudLogin).toHaveBeenCalledTimes(1);
    expect(cloudLoginWindow.preOpen).not.toHaveBeenCalled();
  });

  it("exposes a sign-out action for connected Cloud accounts", () => {
    const handleCloudDisconnect = vi.fn(async () => undefined);
    const handleCloudSignOut = vi.fn(async () => undefined);
    seedCloudOverviewState({
      elizaCloudConnected: true,
      elizaCloudUserId: "user-123",
      handleCloudDisconnect,
      handleCloudSignOut,
    });

    render(<CloudOverviewSection />);

    expect(screen.getByText("Cloud account")).not.toBeNull();
    expect(screen.getByText("Signed in as user-123")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(handleCloudSignOut).toHaveBeenCalledTimes(1);
    expect(handleCloudDisconnect).not.toHaveBeenCalled();
  });

  it("does not show the sign-out row before Cloud is connected", () => {
    seedCloudOverviewState({ elizaCloudConnected: false });

    render(<CloudOverviewSection />);

    expect(screen.queryByText("Cloud account")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("disables sign-out while disconnect is already in flight", () => {
    seedCloudOverviewState({
      elizaCloudConnected: true,
      elizaCloudDisconnecting: true,
    });

    render(<CloudOverviewSection />);

    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Signing out..." })
        .disabled,
    ).toBe(true);
  });
});
