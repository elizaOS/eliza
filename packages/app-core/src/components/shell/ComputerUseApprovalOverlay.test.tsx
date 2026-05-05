/* @vitest-environment jsdom */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerUseApprovalOverlay } from "./ComputerUseApprovalOverlay";

const useAppMock = vi.fn();
const getComputerUseApprovalsMock = vi.fn();
const respondToComputerUseApprovalMock = vi.fn();
const emptyApprovalSnapshot = {
  mode: "full_control",
  pendingCount: 0,
  pendingApprovals: [],
};

vi.mock("../../state", () => ({
  useApp: () => useAppMock(),
}));

vi.mock("../../api/client", () => ({
  client: {
    getBaseUrl: () => "http://127.0.0.1:3000",
    getRestAuthToken: () => null,
    getComputerUseApprovals: (...args: unknown[]) =>
      getComputerUseApprovalsMock(...args),
    respondToComputerUseApproval: (...args: unknown[]) =>
      respondToComputerUseApprovalMock(...args),
  },
}));

/**
 * The overlay prefers SSE, then falls back to polling. A silent stub never
 * triggers `onerror`, so the component would never call `getComputerUseApprovals`
 * (see useEffect) — fire `onerror` after handlers are attached, like a failed stream.
 */
class NoopEventSource {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  close = vi.fn();
  constructor() {
    setTimeout(() => {
      this.onerror?.(new Event("error"));
    }, 0);
  }
}
vi.stubGlobal("EventSource", NoopEventSource);

describe("ComputerUseApprovalOverlay", () => {
  beforeEach(() => {
    useAppMock.mockReset();
    getComputerUseApprovalsMock.mockReset();
    respondToComputerUseApprovalMock.mockReset();
    getComputerUseApprovalsMock.mockResolvedValue(emptyApprovalSnapshot);
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

  it("keeps multiple queued approvals visible and rejects one with a reason", async () => {
    const setActionNotice = vi.fn();
    useAppMock.mockReturnValue({
      setActionNotice,
      t: (_key: string, values?: Record<string, unknown>) =>
        typeof values?.defaultValue === "string" ? values.defaultValue : _key,
    });

    getComputerUseApprovalsMock
      .mockResolvedValueOnce({
        mode: "smart_approve",
        pendingCount: 2,
        pendingApprovals: [
          {
            id: "approval_click",
            command: "click",
            parameters: { x: 10, y: 20 },
            requestedAt: "2026-04-15T00:00:00.000Z",
          },
          {
            id: "approval_type",
            command: "type",
            parameters: { text: "private message" },
            requestedAt: "2026-04-15T00:00:01.000Z",
          },
        ],
      })
      .mockResolvedValueOnce({
        mode: "smart_approve",
        pendingCount: 1,
        pendingApprovals: [
          {
            id: "approval_click",
            command: "click",
            parameters: { x: 10, y: 20 },
            requestedAt: "2026-04-15T00:00:00.000Z",
          },
        ],
      });

    respondToComputerUseApprovalMock.mockResolvedValue({
      id: "approval_type",
      command: "type",
      approved: false,
      cancelled: true,
      mode: "smart_approve",
      requestedAt: "2026-04-15T00:00:01.000Z",
      resolvedAt: "2026-04-15T00:00:06.000Z",
      reason: "Contains private text",
    });

    render(<ComputerUseApprovalOverlay />);

    expect(
      await screen.findByText("Review queued computer actions"),
    ).toBeTruthy();
    expect(screen.getByText("Approval mode: {{mode}}.")).toBeTruthy();
    expect(screen.getByText("click")).toBeTruthy();
    expect(screen.getByText("type")).toBeTruthy();
    expect(screen.getByText(/private message/i)).toBeTruthy();

    const cards = screen
      .getAllByText("Command")
      .map((label) => label.closest("div.rounded-2xl"))
      .filter((card): card is HTMLElement => card !== null);
    expect(cards).toHaveLength(2);

    const typeCard = cards.find((card) => within(card).queryByText("type"));
    expect(typeCard).toBeTruthy();
    if (!typeCard) throw new Error("expected type approval card");

    fireEvent.click(within(typeCard).getByRole("button", { name: "Reject" }));
    fireEvent.change(screen.getByLabelText("Deny reason"), {
      target: { value: "Contains private text" },
    });
    fireEvent.click(within(typeCard).getByRole("button", { name: "Reject" }));

    await waitFor(() => {
      expect(respondToComputerUseApprovalMock).toHaveBeenCalledWith(
        "approval_type",
        false,
        "Contains private text",
      );
    });

    await waitFor(() => {
      expect(setActionNotice).toHaveBeenCalledWith(
        "Rejected type.",
        "info",
        2600,
      );
    });
    await waitFor(() => {
      expect(getComputerUseApprovalsMock).toHaveBeenCalledTimes(2);
    });
  });
});
