// @vitest-environment jsdom

/**
 * Covers CapabilitiesSection's proactive-suggestions control: it reflects the
 * persisted `ELIZA_PROACTIVE_INTERACTIONS` config value and persists the picked
 * level via `updateConfig`. jsdom render with the app store and API client
 * mocked.
 */

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({
  value: {} as {
    walletEnabled: boolean;
    browserEnabled: boolean;
    computerUseEnabled: boolean;
    setState: ReturnType<typeof vi.fn>;
    t: (key: string, options?: { defaultValue?: string }) => string;
  },
}));

const clientMock = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("../../state", () => ({
  useAppSelector: (sel: (value: typeof appMock.value) => unknown) =>
    sel(appMock.value),
  useAppSelectorShallow: (sel: (value: typeof appMock.value) => unknown) =>
    sel(appMock.value),
}));

vi.mock("../../api/client", () => ({ client: clientMock }));

vi.mock("./AdvancedToggle.hooks", () => ({
  useAdvancedSettingsEnabled: () => false,
}));

vi.mock("./AdvancedToggle", () => ({ AdvancedToggle: () => <div /> }));

import { CapabilitiesSection } from "./CapabilitiesSection";

describe("CapabilitiesSection proactive-suggestions control", () => {
  beforeEach(() => {
    appMock.value = {
      walletEnabled: false,
      browserEnabled: false,
      computerUseEnabled: false,
      setState: vi.fn(),
      t: (_key, options) => options?.defaultValue ?? _key,
    };
    clientMock.getConfig.mockReset();
    clientMock.updateConfig.mockReset();
    clientMock.fetch.mockReset();
    // Auto-training config + status (loaded on mount).
    clientMock.fetch.mockImplementation(async (path: string) => {
      if (path === "/api/training/auto/config") {
        return {
          config: {
            autoTrain: false,
            triggerThreshold: 0,
            triggerCooldownHours: 0,
            backends: [],
          },
        };
      }
      if (path === "/api/training/auto/status") {
        return { serviceRegistered: false };
      }
      return {};
    });
    clientMock.updateConfig.mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
  });

  it("reflects the persisted ELIZA_PROACTIVE_INTERACTIONS value", async () => {
    clientMock.getConfig.mockResolvedValue({
      env: { ELIZA_PROACTIVE_INTERACTIONS: "chatty" },
    });

    render(<CapabilitiesSection />);

    const group = await screen.findByTestId("capability-proactive-suggestions");
    await waitFor(() => {
      expect(
        within(group)
          .getByRole("radio", { name: "Chatty" })
          .getAttribute("aria-checked"),
      ).toBe("true");
    });
    expect(
      within(group)
        .getByRole("radio", { name: "Subtle" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("defaults to subtle and persists the selected level via updateConfig", async () => {
    clientMock.getConfig.mockResolvedValue({ env: {} });
    const user = userEvent.setup();

    render(<CapabilitiesSection />);

    const group = await screen.findByTestId("capability-proactive-suggestions");
    // No persisted value → the gate's `subtle` default is active.
    await waitFor(() => {
      expect(
        within(group)
          .getByRole("radio", { name: "Subtle" })
          .getAttribute("aria-checked"),
      ).toBe("true");
    });

    await user.click(within(group).getByRole("radio", { name: "Off" }));

    await waitFor(() => {
      expect(clientMock.updateConfig).toHaveBeenCalledWith({
        env: { ELIZA_PROACTIVE_INTERACTIONS: "off" },
      });
    });
    expect(
      within(group)
        .getByRole("radio", { name: "Off" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });
});
