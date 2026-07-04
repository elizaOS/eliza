// @vitest-environment jsdom

/**
 * Covers AdvancedSection's reset-confirmation modal (no reset until confirmed;
 * runs exactly once) and the encrypted local-backup flow (list/create/restore).
 * jsdom render with the app store and API client mocked.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { handleReset, appValue, clientMock } = vi.hoisted(() => ({
  handleReset: vi.fn(),
  appValue: {} as Record<string, unknown>,
  clientMock: {
    listLocalAgentBackups: vi.fn(),
    createLocalAgentBackup: vi.fn(),
    restoreLocalAgentBackup: vi.fn(),
  },
}));

vi.mock("../../state", () => {
  Object.assign(appValue, {
    t: (key: string) => key,
    handleReset,
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
    useIsDeveloperMode: () => false,
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
  handleReset.mockClear();
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

function openResetModal() {
  fireEvent.click(
    screen.getByRole("button", { name: "settings.resetEverything" }),
  );
}

describe("AdvancedSection reset confirmation", () => {
  it("does not reset until the user confirms in the modal", () => {
    render(<AdvancedSection />);

    // Modal warning is not mounted before the danger-zone button is pressed.
    expect(screen.queryByText("settings.resetConfirmBody")).toBeNull();
    expect(handleReset).not.toHaveBeenCalled();
  });

  it("opens a warning modal when Reset Everything is pressed", () => {
    render(<AdvancedSection />);
    openResetModal();

    expect(screen.getByText("settings.resetConfirmTitle")).toBeTruthy();
    expect(screen.getByText("settings.resetConfirmBody")).toBeTruthy();
    // Opening the warning must never trigger the destructive action by itself.
    expect(handleReset).not.toHaveBeenCalled();
  }, 15_000);

  it("cancels without resetting", () => {
    render(<AdvancedSection />);
    openResetModal();

    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));

    expect(handleReset).not.toHaveBeenCalled();
    expect(screen.queryByText("settings.resetConfirmBody")).toBeNull();
  });

  it("runs the reset exactly once when confirmed", () => {
    render(<AdvancedSection />);
    openResetModal();

    fireEvent.click(
      screen.getByRole("button", { name: "settings.resetConfirmAction" }),
    );

    expect(handleReset).toHaveBeenCalledTimes(1);
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
});
