/** Verifies PairingView hydrates the public pairing-status contract on mount. */
// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PairingView } from "./PairingView";

const mocks = vi.hoisted(() => ({
  getAuthStatus: vi.fn(),
  setState: vi.fn(),
}));

vi.mock("../../api", () => ({
  client: {
    getAuthStatus: mocks.getAuthStatus,
    getBaseUrl: () => "http://remote-agent.example",
  },
}));

vi.mock("../../config/branding", () => ({
  appNameInterpolationVars: () => ({}),
  useBranding: () => ({
    appName: "Eliza",
    orgName: "elizaOS",
    repoName: "eliza",
  }),
}));

vi.mock("../../platform", () => ({
  startFreshFirstRunReload: vi.fn(),
}));

vi.mock("../../state", () => ({
  useAppSelectorShallow: (
    selector: (state: Record<string, unknown>) => unknown,
  ) =>
    selector({
      pairingEnabled: false,
      pairingExpiresAt: null,
      pairingCodeInput: "",
      pairingError: null,
      pairingBusy: false,
      handlePairingSubmit: vi.fn(),
      setState: mocks.setState,
      t: (key: string, values?: { defaultValue?: string }) =>
        values?.defaultValue ?? key,
    }),
}));

vi.mock("./PairingCommandHint", () => ({
  PairingCommandHint: () => null,
}));

beforeEach(() => {
  mocks.getAuthStatus.mockReset();
  mocks.setState.mockReset();
});

afterEach(cleanup);

describe("PairingView auth-status hydration", () => {
  it("enables pair-code entry from the authoritative public status response", async () => {
    const expiresAt = Date.now() + 300_000;
    mocks.getAuthStatus.mockResolvedValue({
      required: true,
      authenticated: false,
      pairingEnabled: true,
      expiresAt,
    });

    render(<PairingView />);

    await waitFor(() => {
      expect(mocks.setState).toHaveBeenCalledWith("pairingEnabled", true);
      expect(mocks.setState).toHaveBeenCalledWith(
        "pairingExpiresAt",
        expiresAt,
      );
    });
  });

  it("does not publish a stale response after the pairing surface unmounts", async () => {
    let resolveStatus: ((value: unknown) => void) | undefined;
    mocks.getAuthStatus.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
    );
    const view = render(<PairingView />);
    view.unmount();

    resolveStatus?.({
      required: true,
      pairingEnabled: true,
      expiresAt: Date.now() + 300_000,
    });
    await Promise.resolve();

    expect(mocks.setState).not.toHaveBeenCalled();
  });
});
