// @vitest-environment jsdom

/**
 * Covers AdvancedSection's normal settings surface: reset controls must stay
 * absent, while the encrypted local-backup flow (list/create/restore) remains
 * available. jsdom render with the app store and API client mocked.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { setActionNotice, appValue, clientMock, devMode } = vi.hoisted(() => ({
  setActionNotice: vi.fn(),
  appValue: {} as Record<string, unknown>,
  clientMock: {
    listLocalAgentBackups: vi.fn(),
    createLocalAgentBackup: vi.fn(),
    restoreLocalAgentBackup: vi.fn(),
    seedDevNotifications: vi.fn(),
  },
  devMode: { value: false },
}));

vi.mock("../../state", () => {
  Object.assign(appValue, {
    t: (key: string) => key,
    setActionNotice,
    exportBusy: false,
    exportPassword: "",
    exportIncludeLogs: false,
    exportError: null,
    exportSuccess: null,
    importBusy: false,
    importPassword: "",
    importFile: null,
    importError: null,
    importSuccess: null,
    handleAgentExport: vi.fn(),
    handleAgentImport: vi.fn(),
    setState: vi.fn(),
  });
  return {
    useApp: () => appValue,
    useAppSelector: (sel: (value: Record<string, unknown>) => unknown) =>
      sel(appValue),
    useAppSelectorShallow: (sel: (value: Record<string, unknown>) => unknown) =>
      sel(appValue),
    useIsDeveloperMode: () => devMode.value,
    setDeveloperMode: vi.fn(),
    useIsPreviewMode: () => false,
    setPreviewMode: vi.fn(),
  };
});

vi.mock("../../api", () => ({
  client: clientMock,
}));

import { AdvancedSection } from "./AdvancedSection";

beforeEach(() => {
  setActionNotice.mockClear();
  devMode.value = false;
  clientMock.seedDevNotifications.mockReset();
  clientMock.seedDevNotifications.mockResolvedValue({
    count: 8,
    notifications: [],
  });
  clientMock.listLocalAgentBackups.mockReset();
  clientMock.listLocalAgentBackups.mockResolvedValue([]);
  clientMock.createLocalAgentBackup.mockReset();
  clientMock.restoreLocalAgentBackup.mockReset();
  clientMock.restoreLocalAgentBackup.mockResolvedValue({
    restored: true,
    requiresRestart: true,
  });
});

afterEach(() => cleanup());

describe("AdvancedSection reset controls", () => {
  it("does not render reset or danger-zone controls in the normal settings path", () => {
    render(<AdvancedSection />);

    expect(
      screen.queryByRole("button", { name: "settings.resetEverything" }),
    ).toBeNull();
    expect(screen.queryByText("settings.dangerZone")).toBeNull();
    expect(screen.queryByText("settings.resetAgent")).toBeNull();
    expect(screen.queryByText("settings.resetConfirmBody")).toBeNull();
  });
});

describe("AdvancedSection agent backups", () => {
  const backup = {
    fileName: "agent-2026-06-29.agent-backup.json",
    agentId: "agent-1",
    createdAt: "2026-06-29T12:34:56.000Z",
    sizeBytes: 2048,
    stateSha256: "1234567890abcdef1234567890abcdef",
  };

  it("lists local encrypted backups when the backup modal opens", async () => {
    clientMock.listLocalAgentBackups.mockResolvedValue([backup]);
    render(<AdvancedSection />);

    fireEvent.click(screen.getByRole("button", { name: "Back Up Agent" }));

    await waitFor(() =>
      expect(clientMock.listLocalAgentBackups).toHaveBeenCalledTimes(1),
    );
    expect(screen.getByText("2026-06-29 12:34:56Z")).toBeTruthy();
    expect(screen.getByText(/2 KB/)).toBeTruthy();
    expect(screen.getByText(/1234567890ab/)).toBeTruthy();
  });

  it("creates a backup through the API and refreshes the list", async () => {
    clientMock.listLocalAgentBackups
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([backup]);
    clientMock.createLocalAgentBackup.mockResolvedValue(backup);
    render(<AdvancedSection />);

    fireEvent.click(screen.getByRole("button", { name: "Back Up Agent" }));
    await screen.findByText("No backups yet.");

    fireEvent.click(screen.getByRole("button", { name: "Create Backup" }));

    await waitFor(() =>
      expect(clientMock.createLocalAgentBackup).toHaveBeenCalledTimes(1),
    );
    await waitFor(() =>
      expect(clientMock.listLocalAgentBackups).toHaveBeenCalledTimes(2),
    );
    expect(
      screen.getByText(/Created backup 2026-06-29 12:34:56Z/),
    ).toBeTruthy();
  });

  it("restores the selected backup through the API", async () => {
    clientMock.listLocalAgentBackups.mockResolvedValue([backup]);
    render(<AdvancedSection />);

    fireEvent.click(screen.getByRole("button", { name: "Restore Agent" }));
    await screen.findByText("2026-06-29 12:34:56Z");

    fireEvent.click(screen.getByRole("button", { name: "Restore Backup" }));

    await waitFor(() =>
      expect(clientMock.restoreLocalAgentBackup).toHaveBeenCalledWith(
        backup.fileName,
      ),
    );
    expect(
      screen.getByText("Restored backup. Restart the agent to activate it."),
    ).toBeTruthy();
  });

  describe("dev notification seeding", () => {
    it("hides the Developer tools group unless developer mode is on", () => {
      render(<AdvancedSection />);
      expect(
        screen.queryByRole("button", { name: "Seed test notifications" }),
      ).toBeNull();
    });

    it("seeds the demo spread and reports the count", async () => {
      devMode.value = true;
      render(<AdvancedSection />);
      fireEvent.click(
        screen.getByRole("button", { name: "Seed test notifications" }),
      );
      await waitFor(() =>
        expect(clientMock.seedDevNotifications).toHaveBeenCalledTimes(1),
      );
      await waitFor(() =>
        expect(setActionNotice).toHaveBeenCalledWith(
          "Seeded 8 test notifications",
          "success",
        ),
      );
    });

    it("surfaces a seeding failure as an error notice", async () => {
      devMode.value = true;
      clientMock.seedDevNotifications.mockRejectedValue(
        new Error("notification route not found"),
      );
      render(<AdvancedSection />);
      fireEvent.click(
        screen.getByRole("button", { name: "Seed test notifications" }),
      );
      await waitFor(() =>
        expect(setActionNotice).toHaveBeenCalledWith(
          "notification route not found",
          "error",
        ),
      );
    });
  });
});
