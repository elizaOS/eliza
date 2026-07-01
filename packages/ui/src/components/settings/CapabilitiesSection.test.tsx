// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
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

  it("does not re-persist when the already-active level is re-selected (idempotent)", async () => {
    clientMock.getConfig.mockResolvedValue({ env: {} });
    const user = userEvent.setup();

    render(<CapabilitiesSection />);

    const group = await screen.findByTestId("capability-proactive-suggestions");
    await waitFor(() => {
      expect(
        within(group)
          .getByRole("radio", { name: "Subtle" })
          .getAttribute("aria-checked"),
      ).toBe("true");
    });

    // Re-selecting the currently-active level is a no-op — the guard
    // (`value === previous`) short-circuits before any network write.
    await user.click(within(group).getByRole("radio", { name: "Subtle" }));
    expect(clientMock.updateConfig).not.toHaveBeenCalled();

    // A real change persists exactly once...
    await user.click(within(group).getByRole("radio", { name: "Chatty" }));
    await waitFor(() => {
      expect(clientMock.updateConfig).toHaveBeenCalledWith({
        env: { ELIZA_PROACTIVE_INTERACTIONS: "chatty" },
      });
    });
    // ...and re-clicking the now-active level does not fire a second write.
    await user.click(within(group).getByRole("radio", { name: "Chatty" }));
    expect(clientMock.updateConfig).toHaveBeenCalledTimes(1);
  });
});

/**
 * Wires the auto-training GET config/status responses loaded on mount, and
 * echoes back the POSTed config the way the real endpoint persists + returns it.
 */
function mockAutoTraining(options: {
  serviceRegistered: boolean;
  autoTrain?: boolean;
}) {
  clientMock.fetch.mockImplementation(async (path: string, init?: unknown) => {
    if (path === "/api/training/auto/config") {
      const requestInit = init as RequestInit | undefined;
      if (requestInit?.method === "POST" && typeof requestInit.body === "string") {
        return { config: JSON.parse(requestInit.body) };
      }
      return {
        config: {
          autoTrain: options.autoTrain ?? false,
          triggerThreshold: 3,
          triggerCooldownHours: 6,
          backends: ["apollo"],
        },
      };
    }
    if (path === "/api/training/auto/status") {
      return { serviceRegistered: options.serviceRegistered };
    }
    return {};
  });
}

describe("CapabilitiesSection store-backed capability switches", () => {
  beforeEach(() => {
    appMock.value = {
      walletEnabled: false,
      browserEnabled: false,
      computerUseEnabled: false,
      setState: vi.fn(),
      t: (_key, options) => options?.defaultValue ?? _key,
    };
    clientMock.getConfig.mockReset();
    clientMock.getConfig.mockResolvedValue({ env: {} });
    clientMock.updateConfig.mockReset();
    clientMock.updateConfig.mockResolvedValue({});
    clientMock.fetch.mockReset();
    mockAutoTraining({ serviceRegistered: false });
  });

  afterEach(() => {
    cleanup();
  });

  it("reflects the store enabled state on each capability switch", async () => {
    appMock.value.walletEnabled = true;
    appMock.value.browserEnabled = false;
    appMock.value.computerUseEnabled = true;

    render(<CapabilitiesSection />);

    expect(
      screen.getByRole("switch", { name: "Enable Wallet" }).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
    expect(
      screen.getByRole("switch", { name: "Enable Browser" }).getAttribute(
        "aria-checked",
      ),
    ).toBe("false");
    expect(
      screen
        .getByRole("switch", { name: "Enable Computer Use" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("toggling a disabled capability on calls setState with that capability's key and true", async () => {
    const user = userEvent.setup();
    render(<CapabilitiesSection />);

    await user.click(screen.getByRole("switch", { name: "Enable Wallet" }));

    expect(appMock.value.setState).toHaveBeenCalledTimes(1);
    expect(appMock.value.setState).toHaveBeenCalledWith("walletEnabled", true);
  });

  it("toggling an enabled capability off calls setState with that capability's key and false", async () => {
    appMock.value.browserEnabled = true;
    const user = userEvent.setup();
    render(<CapabilitiesSection />);

    await user.click(screen.getByRole("switch", { name: "Enable Browser" }));

    expect(appMock.value.setState).toHaveBeenCalledWith("browserEnabled", false);
  });

  it("routes each capability toggle to its own store key (no cross-talk)", async () => {
    const user = userEvent.setup();
    render(<CapabilitiesSection />);

    await user.click(
      screen.getByRole("switch", { name: "Enable Computer Use" }),
    );

    expect(appMock.value.setState).toHaveBeenCalledWith(
      "computerUseEnabled",
      true,
    );
    // The computer-use toggle must not touch the wallet/browser keys.
    for (const [key] of appMock.value.setState.mock.calls) {
      expect(key).toBe("computerUseEnabled");
    }
  });
});

describe("CapabilitiesSection auto-training gating", () => {
  beforeEach(() => {
    appMock.value = {
      walletEnabled: false,
      browserEnabled: false,
      computerUseEnabled: false,
      setState: vi.fn(),
      t: (_key, options) => options?.defaultValue ?? _key,
    };
    clientMock.getConfig.mockReset();
    clientMock.getConfig.mockResolvedValue({ env: {} });
    clientMock.updateConfig.mockReset();
    clientMock.updateConfig.mockResolvedValue({});
    clientMock.fetch.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("disables the auto-training toggle and fires no write when the service is unavailable", async () => {
    mockAutoTraining({ serviceRegistered: false });
    render(<CapabilitiesSection />);

    const toggle = await screen.findByRole("switch", {
      name: "Enable Auto-training",
    });
    await waitFor(() => {
      expect((toggle as HTMLButtonElement).disabled).toBe(true);
    });
    // An "unavailable" affordance is surfaced next to the label.
    expect(screen.getByRole("img", { name: "Unavailable" })).toBeTruthy();

    // A disabled control cannot dispatch — no config POST is ever attempted.
    fireEvent.click(toggle);
    const posted = clientMock.fetch.mock.calls.some(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    expect(posted).toBe(false);
  });

  it("enabling auto-training POSTs the full config with autoTrain:true and reflects the result", async () => {
    mockAutoTraining({ serviceRegistered: true, autoTrain: false });
    const user = userEvent.setup();
    render(<CapabilitiesSection />);

    const toggle = await screen.findByRole("switch", {
      name: "Enable Auto-training",
    });
    await waitFor(() => {
      expect((toggle as HTMLButtonElement).disabled).toBe(false);
    });

    await user.click(toggle);

    await waitFor(() => {
      expect(clientMock.fetch).toHaveBeenCalledWith(
        "/api/training/auto/config",
        {
          method: "POST",
          body: JSON.stringify({
            autoTrain: true,
            triggerThreshold: 3,
            triggerCooldownHours: 6,
            backends: ["apollo"],
          }),
        },
      );
    });
    await waitFor(() => {
      expect(
        screen
          .getByRole("switch", { name: "Enable Auto-training" })
          .getAttribute("aria-checked"),
      ).toBe("true");
    });
  });

  it("locks out a rapid second toggle while the write is in flight (idempotent)", async () => {
    let resolvePost: ((value: unknown) => void) | undefined;
    clientMock.fetch.mockImplementation(async (path: string, init?: unknown) => {
      if (path === "/api/training/auto/config") {
        const method = (init as RequestInit | undefined)?.method;
        if (method === "POST") {
          return new Promise((resolve) => {
            resolvePost = () =>
              resolve({
                config: {
                  autoTrain: true,
                  triggerThreshold: 3,
                  triggerCooldownHours: 6,
                  backends: ["apollo"],
                },
              });
          });
        }
        return {
          config: {
            autoTrain: false,
            triggerThreshold: 3,
            triggerCooldownHours: 6,
            backends: ["apollo"],
          },
        };
      }
      if (path === "/api/training/auto/status") {
        return { serviceRegistered: true };
      }
      return {};
    });

    const user = userEvent.setup();
    render(<CapabilitiesSection />);

    const toggle = await screen.findByRole("switch", {
      name: "Enable Auto-training",
    });
    await waitFor(() => {
      expect((toggle as HTMLButtonElement).disabled).toBe(false);
    });

    await user.click(toggle);

    // In-flight save disables the control, so a second click cannot double-post.
    await waitFor(() => {
      expect((toggle as HTMLButtonElement).disabled).toBe(true);
    });
    fireEvent.click(toggle);

    const postCount = () =>
      clientMock.fetch.mock.calls.filter(
        ([path, init]) =>
          path === "/api/training/auto/config" &&
          (init as RequestInit | undefined)?.method === "POST",
      ).length;
    expect(postCount()).toBe(1);

    resolvePost?.({});
    await waitFor(() => {
      expect((toggle as HTMLButtonElement).disabled).toBe(false);
    });
    expect(postCount()).toBe(1);
  });
});
