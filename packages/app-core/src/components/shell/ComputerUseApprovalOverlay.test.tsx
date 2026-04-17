/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerUseApprovalOverlay } from "./ComputerUseApprovalOverlay";

const useAppMock = vi.fn();
const getComputerUseApprovalsMock = vi.fn();
const respondToComputerUseApprovalMock = vi.fn();

vi.mock("../../state", () => ({
  useApp: () => useAppMock(),
}));

vi.mock("../../api/client", () => ({
  client: {
    getComputerUseApprovals: (...args: unknown[]) =>
      getComputerUseApprovalsMock(...args),
    respondToComputerUseApproval: (...args: unknown[]) =>
      respondToComputerUseApprovalMock(...args),
  },
}));

describe("ComputerUseApprovalOverlay", () => {
  beforeEach(() => {
    useAppMock.mockReset();
    getComputerUseApprovalsMock.mockReset();
    respondToComputerUseApprovalMock.mockReset();
    useAppMock.mockReturnValue({
      setActionNotice: vi.fn(),
      t: (_key: string, values?: Record<string, unknown>) =>
        typeof values?.defaultValue === "string" ? values.defaultValue : _key,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("stays hidden when there are no pending approvals", async () => {
    getComputerUseApprovalsMock.mockResolvedValue({
      mode: "full_control",
      pendingCount: 0,
      pendingApprovals: [],
    });

    render(<ComputerUseApprovalOverlay />);

    await waitFor(() => {
      expect(getComputerUseApprovalsMock).toHaveBeenCalled();
    });

    expect(screen.queryByText("Review queued computer actions")).toBeNull();
  });

  it("renders the pending command and resolves approval from the overlay", async () => {
    const setActionNotice = vi.fn();
    useAppMock.mockReturnValue({
      setActionNotice,
      t: (_key: string, values?: Record<string, unknown>) =>
        typeof values?.defaultValue === "string" ? values.defaultValue : _key,
    });

    getComputerUseApprovalsMock
      .mockResolvedValueOnce({
        mode: "approve_all",
        pendingCount: 1,
        pendingApprovals: [
          {
            id: "approval_1",
            command: "browser_navigate",
            parameters: { url: "https://example.com" },
            requestedAt: "2026-04-15T00:00:00.000Z",
          },
        ],
      })
      .mockResolvedValueOnce({
        mode: "approve_all",
        pendingCount: 0,
        pendingApprovals: [],
      });

    respondToComputerUseApprovalMock.mockResolvedValue({
      id: "approval_1",
      command: "browser_navigate",
      approved: true,
      cancelled: false,
      mode: "approve_all",
      requestedAt: "2026-04-15T00:00:00.000Z",
      resolvedAt: "2026-04-15T00:00:05.000Z",
    });

    render(<ComputerUseApprovalOverlay />);

    expect(
      await screen.findByText("Review queued computer actions"),
    ).toBeTruthy();
    expect(screen.getByText("browser_navigate")).toBeTruthy();
    expect(screen.getByText(/example\.com/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => {
      expect(respondToComputerUseApprovalMock).toHaveBeenCalledWith(
        "approval_1",
        true,
        undefined,
      );
    });

    await waitFor(() => {
      expect(setActionNotice).toHaveBeenCalledWith(
        "Approved browser_navigate.",
        "success",
        2600,
      );
    });
  });
});
