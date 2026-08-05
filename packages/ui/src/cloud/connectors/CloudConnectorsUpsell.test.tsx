/** Verifies CloudConnectorsSettingsBody through the package's configured test harness. */
// @vitest-environment jsdom
/**
 * Covers the Cloud Connectors upsell's trusted-click login handoff. Desktop
 * login must retain the shared popup before the asynchronous session request.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __setAppValueForTests } from "../../state/app-store";
import CloudConnectorsSettingsBody from "./CloudConnectorsUpsell";

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

vi.mock("./CloudConnectorsSection", () => ({
  CloudConnectorsSection: () => null,
}));

function t(_key: string, opts?: { defaultValue?: string }) {
  return opts?.defaultValue ?? _key;
}

afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
  vi.clearAllMocks();
});

describe("CloudConnectorsSettingsBody", () => {
  it("pre-opens the shared cloud auth window before starting login", () => {
    const handleCloudLogin = vi.fn(async () => undefined);
    cloudLoginWindow.preOpen.mockReturnValue(cloudLoginWindow.popup);
    __setAppValueForTests({
      t,
      elizaCloudConnected: false,
      elizaCloudLoginBusy: false,
      handleCloudLogin,
      setActionNotice: vi.fn(),
    } as never);

    render(<CloudConnectorsSettingsBody />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Cloud" }));

    expect(cloudLoginWindow.preOpen).toHaveBeenCalledTimes(1);
    expect(handleCloudLogin).toHaveBeenCalledWith(cloudLoginWindow.popup);
  });
});
