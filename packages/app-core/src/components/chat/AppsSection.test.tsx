// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { useAppMock, clientMock } = vi.hoisted(() => ({
  useAppMock: vi.fn(),
  clientMock: {
    listApps: vi.fn(),
    launchApp: vi.fn(),
  },
}));

vi.mock("../../state", () => ({
  useApp: () => useAppMock(),
}));

vi.mock("../../api", () => ({
  client: clientMock,
}));

import { AppsSection } from "./AppsSection";

function buildUseAppState(overrides?: Record<string, unknown>) {
  return {
    favoriteApps: ["@elizaos/app-lifeops"],
    appRuns: [],
    setTab: vi.fn(),
    setState: vi.fn(),
    setActionNotice: vi.fn(),
    t: (key: string, vars?: { defaultValue?: string }) =>
      vars?.defaultValue ?? key,
    ...overrides,
  };
}

describe("AppsSection", () => {
  beforeEach(() => {
    useAppMock.mockReset();
    clientMock.listApps.mockReset();
    clientMock.launchApp.mockReset();

    useAppMock.mockReturnValue(buildUseAppState());
    clientMock.listApps.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  it("opens the apps view from the section header", async () => {
    const setTab = vi.fn();
    useAppMock.mockReturnValue(buildUseAppState({ setTab }));

    render(<AppsSection />);

    fireEvent.click(await screen.findByRole("button", { name: "Open View" }));

    expect(setTab).toHaveBeenCalledWith("apps");
  });

  it("navigates internal tool apps through setTab instead of relaunching", async () => {
    const setTab = vi.fn();
    useAppMock.mockReturnValue(buildUseAppState({ setTab }));

    render(<AppsSection />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Launch LifeOps" }),
    );

    await waitFor(() => {
      expect(setTab).toHaveBeenCalledWith("lifeops");
    });
    expect(clientMock.launchApp).not.toHaveBeenCalled();
  });
});
