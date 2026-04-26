// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    getLifeOpsScreenTimeBreakdown: vi.fn(),
    getLifeOpsSocialHabitSummary: vi.fn(),
  },
}));

vi.mock("@elizaos/app-core", () => ({
  client: clientMock,
}));

import { LifeOpsScreenTimeSection } from "./LifeOpsScreenTimeSection.js";

const breakdown = {
  byBrowser: [{ key: "Arc", label: "Arc", totalSeconds: 900 }],
  byCategory: [{ key: "dev", label: "Development", totalSeconds: 3600 }],
  byDevice: [{ key: "desktop", label: "Desktop", totalSeconds: 3600 }],
  byService: [],
  bySource: [{ key: "app", label: "Apps", totalSeconds: 3600 }],
  fetchedAt: "2026-04-25T12:00:00.000Z",
  items: [
    {
      displayName: "Editor",
      identifier: "com.example.Editor",
      source: "app",
      totalSeconds: 3600,
    },
  ],
  totalSeconds: 3600,
};

const social = {
  browsers: [],
  dataSources: [],
  devices: [],
  fetchedAt: "2026-04-25T12:00:00.000Z",
  messages: {
    channels: [
      {
        channel: "imessage",
        inbound: 2,
        opened: 3,
        outbound: 1,
      },
    ],
    inbound: 2,
    opened: 3,
    outbound: 1,
    replied: 1,
  },
  services: [{ key: "x", label: "X", totalSeconds: 600 }],
  sessions: [],
  since: "2026-04-25T00:00:00.000Z",
  surfaces: [],
  totalSeconds: 600,
  until: "2026-04-25T12:00:00.000Z",
};

beforeEach(() => {
  clientMock.getLifeOpsScreenTimeBreakdown.mockResolvedValue(breakdown);
  clientMock.getLifeOpsSocialHabitSummary.mockResolvedValue(social);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LifeOpsScreenTimeSection", () => {
  it("loads screen-time and social summaries for the selected range", async () => {
    render(<LifeOpsScreenTimeSection />);

    expect(screen.getByTestId("lifeops-screen-time-section")).toBeTruthy();
    await waitFor(() =>
      expect(clientMock.getLifeOpsScreenTimeBreakdown).toHaveBeenCalledWith(
        expect.objectContaining({ topN: 16 }),
      ),
    );
    expect(clientMock.getLifeOpsSocialHabitSummary).toHaveBeenCalledWith(
      expect.objectContaining({ topN: 12 }),
    );
    expect(await screen.findByText("Editor")).toBeTruthy();
    expect(screen.getByText("Development")).toBeTruthy();
  });
});
