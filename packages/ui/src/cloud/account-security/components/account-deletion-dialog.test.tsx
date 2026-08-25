/** Renders every account-deletion admission state with deterministic client responses. */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deletionClient = vi.hoisted(() => ({
  getAccountDeletionStatus: vi.fn(),
  submitAccountDeletion: vi.fn(),
  endLocalSessionAfterDeletion: vi.fn(),
}));

vi.mock("../data/account-deletion-client", () => deletionClient);

import { AccountDeletionDialog } from "./account-deletion-dialog";

beforeEach(() => {
  deletionClient.getAccountDeletionStatus.mockReset();
  deletionClient.submitAccountDeletion.mockReset();
  deletionClient.endLocalSessionAfterDeletion.mockReset();
});
afterEach(cleanup);

describe("AccountDeletionDialog", () => {
  it("keeps the destructive trigger disabled while status loads", async () => {
    let resolveStatus:
      | ((value: { state: "available"; request: null }) => void)
      | undefined;
    deletionClient.getAccountDeletionStatus.mockReturnValue(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );
    render(<AccountDeletionDialog />);

    expect(
      (screen.getByTestId("delete-account-trigger") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText("Checking deletion status…")).toBeTruthy();
    resolveStatus?.({ state: "available", request: null });
    await screen.findByText("Delete account");
  });

  it("shows support without a destructive action when lifecycle admission is unavailable", async () => {
    deletionClient.getAccountDeletionStatus.mockResolvedValue({
      state: "lifecycle_unavailable",
      request: null,
      code: "LIFECYCLE_RESERVATION_REQUIRED",
      message: "Lifecycle reservation required",
    });
    render(<AccountDeletionDialog />);

    expect(
      ((await screen.findByText("Deletion unavailable")) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      screen
        .getByRole("link", { name: "Contact support" })
        .getAttribute("href"),
    ).toContain("mailto:support@eliza.cloud");
    expect(deletionClient.submitAccountDeletion).not.toHaveBeenCalled();
  });

  it("distinguishes transfer requirements and existing receipts", async () => {
    deletionClient.getAccountDeletionStatus.mockResolvedValueOnce({
      state: "transfer_required",
      request: null,
      code: "TRANSFER_REQUIRED",
      message: "Transfer resources",
    });
    const first = render(<AccountDeletionDialog />);
    expect(
      ((await screen.findByText("Transfer required")) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    first.unmount();

    deletionClient.getAccountDeletionStatus.mockResolvedValueOnce({
      state: "existing_request",
      request: {
        requestId: "request-1",
        status: "action_required",
        requestedAt: "2026-08-19T00:00:00.000Z",
        scheduledDeletionAt: "2026-09-18T00:00:00.000Z",
        identityDeactivated: false,
        completedAt: null,
      },
    });
    render(<AccountDeletionDialog />);
    expect(
      ((await screen.findByText("Request needs support")) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(/Reference request-1/)).toBeTruthy();
  });

  it("only exposes confirmation after the server reports available", async () => {
    deletionClient.getAccountDeletionStatus.mockResolvedValue({
      state: "available",
      request: null,
    });
    render(<AccountDeletionDialog />);

    const trigger = await screen.findByText("Delete account");
    expect((trigger as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(trigger);
    expect(screen.getByLabelText("Type DELETE to confirm")).toBeTruthy();
    expect(
      (screen.getByTestId("delete-account-confirm") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("does not retire the session when the POST receipt is malformed", async () => {
    deletionClient.getAccountDeletionStatus.mockResolvedValue({
      state: "available",
      request: null,
    });
    deletionClient.submitAccountDeletion.mockRejectedValue(
      new Error("Account deletion response was malformed"),
    );
    const locationBefore = window.location.href;
    render(<AccountDeletionDialog />);

    fireEvent.click(await screen.findByText("Delete account"));
    fireEvent.change(screen.getByLabelText("Type DELETE to confirm"), {
      target: { value: "DELETE" },
    });
    fireEvent.click(screen.getByTestId("delete-account-confirm"));

    await waitFor(() => {
      expect(
        screen.getByText("Account deletion response was malformed"),
      ).toBeTruthy();
    });
    expect(deletionClient.endLocalSessionAfterDeletion).not.toHaveBeenCalled();
    expect(window.location.href).toBe(locationBefore);
  });

  it("does not retire the session when the server refuses the confirmed request", async () => {
    deletionClient.getAccountDeletionStatus.mockResolvedValue({
      state: "available",
      request: null,
    });
    deletionClient.submitAccountDeletion.mockRejectedValue(
      new Error("Permanent account deletion is unavailable"),
    );
    render(<AccountDeletionDialog />);

    fireEvent.click(await screen.findByText("Delete account"));
    fireEvent.change(screen.getByLabelText("Type DELETE to confirm"), {
      target: { value: "DELETE" },
    });
    fireEvent.click(screen.getByTestId("delete-account-confirm"));

    await screen.findByText("Permanent account deletion is unavailable");
    expect(deletionClient.endLocalSessionAfterDeletion).not.toHaveBeenCalled();
  });

  it("retires the local authority only after a validated confirmed receipt", async () => {
    deletionClient.getAccountDeletionStatus.mockResolvedValue({
      state: "available",
      request: null,
    });
    deletionClient.submitAccountDeletion.mockResolvedValue({
      requestId: "request-validated",
      status: "scheduled",
      requestedAt: "2026-08-23T00:00:00.000Z",
      scheduledDeletionAt: "2026-09-22T00:00:00.000Z",
      identityDeactivated: true,
      completedAt: null,
    });
    deletionClient.endLocalSessionAfterDeletion.mockResolvedValue(undefined);
    render(<AccountDeletionDialog />);

    fireEvent.click(await screen.findByText("Delete account"));
    fireEvent.change(screen.getByLabelText("Type DELETE to confirm"), {
      target: { value: "DELETE" },
    });
    fireEvent.click(screen.getByTestId("delete-account-confirm"));

    await waitFor(() => {
      expect(deletionClient.endLocalSessionAfterDeletion).toHaveBeenCalledTimes(
        1,
      );
    });
  });
});
