/* @vitest-environment jsdom */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilitiesSection } from "./CapabilitiesSection";

const useAppMock = vi.fn();
const clientFetchMock = vi.fn();

vi.mock("../../state", () => ({
  useApp: () => useAppMock(),
}));

vi.mock("../../api/client", () => ({
  client: {
    fetch: (...args: unknown[]) => clientFetchMock(...args),
  },
}));

describe("CapabilitiesSection", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    useAppMock.mockReset();
    clientFetchMock.mockReset();
    clientFetchMock.mockImplementation((path: string) => {
      if (path === "/api/training/auto/config") {
        return Promise.resolve({
          config: {
            autoTrain: false,
            triggerThreshold: 10,
            triggerCooldownHours: 24,
            backends: [],
          },
        });
      }
      if (path === "/api/training/auto/status") {
        return Promise.resolve({ serviceRegistered: true });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
  });

  it("renders the computer use capability and its config hint when enabled", () => {
    useAppMock.mockReturnValue({
      walletEnabled: false,
      browserEnabled: false,
      computerUseEnabled: true,
      setState: vi.fn(),
      t: (_key: string, values?: Record<string, unknown>) =>
        typeof values?.defaultValue === "string" ? values.defaultValue : _key,
    });

    render(<CapabilitiesSection />);

    expect(
      screen.getByRole("switch", { name: "Enable Computer Use" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/Accessibility and Screen Recording permissions/i),
    ).toBeTruthy();
  });

  it("hides the computer use config hint when disabled", () => {
    useAppMock.mockReturnValue({
      walletEnabled: false,
      browserEnabled: false,
      computerUseEnabled: false,
      setState: vi.fn(),
      t: (_key: string, values?: Record<string, unknown>) =>
        typeof values?.defaultValue === "string" ? values.defaultValue : _key,
    });

    render(<CapabilitiesSection />);

    expect(
      screen.getByRole("switch", { name: "Enable Computer Use" }),
    ).toBeTruthy();
    expect(
      screen.queryByText(/Accessibility and Screen Recording permissions/i),
    ).toBeNull();
  });

  it("keeps the browser and computer-use toggles mapped to separate state keys", () => {
    const setState = vi.fn();
    useAppMock.mockReturnValue({
      walletEnabled: false,
      browserEnabled: false,
      computerUseEnabled: false,
      setState,
      t: (_key: string, values?: Record<string, unknown>) =>
        typeof values?.defaultValue === "string" ? values.defaultValue : _key,
    });

    render(<CapabilitiesSection />);

    fireEvent.click(screen.getByRole("switch", { name: "Enable Browser" }));
    fireEvent.click(
      screen.getByRole("switch", { name: "Enable Computer Use" }),
    );

    expect(setState).toHaveBeenCalledWith("browserEnabled", true);
    expect(setState).toHaveBeenCalledWith("computerUseEnabled", true);
    expect(setState).not.toHaveBeenCalledWith("walletEnabled", true);
  });

  it("reports auto-training plugin status without enabling a missing service", async () => {
    clientFetchMock.mockImplementation((path: string) => {
      if (path === "/api/training/auto/config") {
        return Promise.resolve({
          config: {
            autoTrain: true,
            triggerThreshold: 10,
            triggerCooldownHours: 24,
            backends: ["local"],
          },
        });
      }
      if (path === "/api/training/auto/status") {
        return Promise.resolve({ serviceRegistered: false });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const setState = vi.fn();
    useAppMock.mockReturnValue({
      walletEnabled: false,
      browserEnabled: false,
      computerUseEnabled: false,
      setState,
      t: (_key: string, values?: Record<string, unknown>) =>
        typeof values?.defaultValue === "string" ? values.defaultValue : _key,
    });

    render(<CapabilitiesSection />);

    expect(await screen.findByLabelText("Unavailable")).toBeTruthy();
    expect(
      (
        screen.getByRole("switch", {
          name: "Enable Auto-training",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("persists the auto-training toggle through the mocked settings API", async () => {
    clientFetchMock.mockImplementation(
      (path: string, init?: { method?: string; body?: string }) => {
        if (path === "/api/training/auto/config" && init?.method === "POST") {
          return Promise.resolve({
            config: JSON.parse(init.body ?? "{}"),
          });
        }
        if (path === "/api/training/auto/config") {
          return Promise.resolve({
            config: {
              autoTrain: false,
              triggerThreshold: 10,
              triggerCooldownHours: 24,
              backends: [],
            },
          });
        }
        if (path === "/api/training/auto/status") {
          return Promise.resolve({ serviceRegistered: true });
        }
        throw new Error(`Unexpected request: ${path}`);
      },
    );
    useAppMock.mockReturnValue({
      walletEnabled: false,
      browserEnabled: false,
      computerUseEnabled: false,
      setState: vi.fn(),
      t: (_key: string, values?: Record<string, unknown>) =>
        typeof values?.defaultValue === "string" ? values.defaultValue : _key,
    });

    render(<CapabilitiesSection />);

    const autoTrainingSwitch = await screen.findByRole("switch", {
      name: "Enable Auto-training",
    });
    await waitFor(() => {
      expect((autoTrainingSwitch as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(autoTrainingSwitch);

    await waitFor(() => {
      expect(clientFetchMock).toHaveBeenCalledWith(
        "/api/training/auto/config",
        {
          method: "POST",
          body: JSON.stringify({
            autoTrain: true,
            triggerThreshold: 10,
            triggerCooldownHours: 24,
            backends: [],
          }),
        },
      );
    });
  });
});
