/** Verifies AdvancedSection reset controls through the package's configured test harness. */
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

const { appValue, clientMock } = vi.hoisted(() => ({
  appValue: {} as Record<string, unknown>,
  clientMock: {
    listLocalAgentBackups: vi.fn(),
    createLocalAgentBackup: vi.fn(),
    restoreLocalAgentBackup: vi.fn(),
    getBaseUrl: vi.fn(() => "http://127.0.0.1:31337"),
  },
}));

vi.mock("../../state/useApp", () => {
  Object.assign(appValue, {
    t: (key: string) => key,
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
  return { useApp: () => appValue };
});
vi.mock("../../state/app-store", () => {
  Object.assign(appValue, {
    t: (key: string) => key,
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
    useAppSelector: (sel: (value: Record<string, unknown>) => unknown) =>
      sel(appValue),
    useAppSelectorShallow: (sel: (value: Record<string, unknown>) => unknown) =>
      sel(appValue),
  };
});

vi.mock("../../api/client", () => ({ client: clientMock }));

import { AdvancedSection } from "./AdvancedSection";

beforeEach(() => {
  clientMock.getBaseUrl.mockReturnValue("http://127.0.0.1:31337");
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
  it("keeps the Backups destination free of unrelated developer controls", () => {
    render(<AdvancedSection />);

    expect(
      screen.queryByRole("button", { name: "settings.resetEverything" }),
    ).toBeNull();
    expect(screen.queryByText("settings.dangerZone")).toBeNull();
    expect(screen.queryByText("settings.resetAgent")).toBeNull();
    expect(screen.queryByText("settings.resetConfirmBody")).toBeNull();
    expect(screen.queryByText("View visibility")).toBeNull();
    expect(screen.queryByText("Developer tools")).toBeNull();
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

  it("renders a truthful unavailable state for Dedicated agents", () => {
    clientMock.getBaseUrl.mockReturnValue(
      "https://11111111-1111-4111-8111-111111111111.staging.elizacloud.ai",
    );
    render(<AdvancedSection />);

    expect(
      screen.getByText(/Manual backups are not available for Dedicated agents/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Back up agent/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Restore agent/i })).toBeNull();
  });

  it("lists local encrypted backups when the backup modal opens", async () => {
    clientMock.listLocalAgentBackups.mockResolvedValue([backup]);
    render(<AdvancedSection />);

    fireEvent.click(screen.getByRole("button", { name: /Back up agent/i }));

    await waitFor(() =>
      expect(clientMock.listLocalAgentBackups).toHaveBeenCalledTimes(1),
    );
    expect(screen.getByText("2026-06-29 12:34:56Z")).toBeTruthy();
    expect(screen.getByText(/2 KB/)).toBeTruthy();
    expect(screen.getByText(/1234567890ab/)).toBeTruthy();
  });

  it("shows a backup just under 1 MB as 1.0 MB", async () => {
    clientMock.listLocalAgentBackups.mockResolvedValue([
      {
        ...backup,
        fileName: "almost-one-mb.agent-backup.json",
        sizeBytes: 1024 * 1024 - 1,
      },
      {
        ...backup,
        fileName: "still-kb.agent-backup.json",
        sizeBytes: 1023 * 1024,
      },
    ]);
    render(<AdvancedSection />);

    fireEvent.click(screen.getByRole("button", { name: /Back up agent/i }));

    await waitFor(() =>
      expect(clientMock.listLocalAgentBackups).toHaveBeenCalledTimes(1),
    );
    expect(screen.getByText(/1\.0 MB/)).toBeTruthy();
    expect(screen.queryByText(/1024 KB/)).toBeNull();
    expect(screen.getByText(/1023 KB/)).toBeTruthy();
  });

  it("creates a backup through the API and refreshes the list", async () => {
    clientMock.listLocalAgentBackups
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([backup]);
    clientMock.createLocalAgentBackup.mockResolvedValue(backup);
    render(<AdvancedSection />);

    fireEvent.click(screen.getByRole("button", { name: /Back up agent/i }));
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

  it("shows the size-limit refusal as-is and without a retry hint", async () => {
    const message =
      "Agent state is too large for a local backup (150.0 MB; the limit is 128.0 MB). Retrying will not help until the agent's state is smaller.";
    clientMock.createLocalAgentBackup.mockRejectedValue(
      Object.assign(new Error(message), {
        status: 413,
        code: "AGENT_SNAPSHOT_BUDGET_EXCEEDED",
        data: { error: message, retryable: false },
      }),
    );
    render(<AdvancedSection />);

    fireEvent.click(screen.getByRole("button", { name: /Back up agent/i }));
    await screen.findByText("No backups yet.");
    fireEvent.click(screen.getByRole("button", { name: "Create Backup" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(message);
  });

  it("marks an unexpected backup failure as retryable", async () => {
    clientMock.createLocalAgentBackup.mockRejectedValue(
      Object.assign(new Error("Backup failed"), {
        status: 500,
        data: { error: "Backup failed" },
      }),
    );
    render(<AdvancedSection />);

    fireEvent.click(screen.getByRole("button", { name: /Back up agent/i }));
    await screen.findByText("No backups yet.");
    fireEvent.click(screen.getByRole("button", { name: "Create Backup" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Backup failed. This may be temporary; try again.",
    );
  });

  it("restores the selected backup through the API", async () => {
    clientMock.listLocalAgentBackups.mockResolvedValue([backup]);
    render(<AdvancedSection />);

    fireEvent.click(screen.getByRole("button", { name: /Restore agent/i }));
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
