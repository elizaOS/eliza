// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { clientMock, selectMock } = vi.hoisted(() => ({
  clientMock: {
    getLifeOpsOverview: vi.fn(),
    listLifeOpsDefinitions: vi.fn(),
  },
  selectMock: vi.fn(),
}));

vi.mock("@elizaos/app-core", () => ({
  client: clientMock,
  useApp: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? _key,
  }),
}));

vi.mock("./LifeOpsChatAdapter.js", () => ({
  useLifeOpsChatLauncher: () => ({
    chatAboutReminder: vi.fn(),
  }),
}));

vi.mock("./LifeOpsSelectionContext.js", () => ({
  useLifeOpsSelection: () => ({
    select: selectMock,
    selection: {},
  }),
}));

import { LifeOpsRemindersSection } from "./LifeOpsRemindersSection.js";

beforeEach(() => {
  clientMock.getLifeOpsOverview.mockResolvedValue({ reminders: [] });
  clientMock.listLifeOpsDefinitions.mockResolvedValue({ definitions: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LifeOpsRemindersSection", () => {
  it("loads reminders and definitions for the reminders route shell", async () => {
    render(<LifeOpsRemindersSection />);

    expect(screen.getByTestId("lifeops-reminders")).toBeTruthy();
    await waitFor(() => expect(clientMock.getLifeOpsOverview).toHaveBeenCalled());
    expect(clientMock.listLifeOpsDefinitions).toHaveBeenCalled();
    expect(
      await screen.findByText("All clear. No active reminders."),
    ).toBeTruthy();
  });
});
