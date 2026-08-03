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
  it("invokes the interactive login entry point and does not pre-open the window itself", () => {
    const handleInteractiveCloudLogin = vi.fn(async () => undefined);
    __setAppValueForTests({
      t,
      elizaCloudConnected: false,
      elizaCloudLoginBusy: false,
      handleInteractiveCloudLogin,
      setActionNotice: vi.fn(),
    } as never);

    render(<CloudConnectorsSettingsBody />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Cloud" }));

    // #17129: the interactive entry point owns popup pre-opening. The
    // component must call the entry point and must NOT call the raw
    // pre-open/window path itself — otherwise a future interactive call site
    // could omit the popup and compile the old defect.
    expect(handleInteractiveCloudLogin).toHaveBeenCalledTimes(1);
    expect(cloudLoginWindow.preOpen).not.toHaveBeenCalled();
  });
});
