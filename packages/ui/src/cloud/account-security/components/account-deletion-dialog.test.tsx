/** Exercises exact confirmation, recent-auth errors, and retryable deletion acceptance in jsdom. */

// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const submitMock = vi.hoisted(() => vi.fn());
const endSessionMock = vi.hoisted(() => vi.fn());

vi.mock("../data/account-deletion-client", () => ({
  endLocalSessionAfterDeletion: endSessionMock,
  submitAccountDeletion: submitMock,
}));

import { AccountDeletionDialog } from "./account-deletion-dialog";

const acceptedRequest = {
  requestId: "33333333-3333-4333-8333-333333333333",
  status: "reserved" as const,
  requestedAt: "2026-08-22T12:00:00.000Z",
  recoveryExpiresAt: "2026-09-21T12:00:00.000Z",
  scheduledDeletionAt: "2026-09-21T12:00:00.000Z",
  irreversibleAt: null,
  completedAt: null,
  identityDeactivated: true,
  accessState: "fenced" as const,
  canCancel: true,
  nextAction: "wait_for_export" as const,
  export: null,
};

describe("AccountDeletionDialog", () => {
  beforeEach(() => {
    submitMock.mockReset();
    endSessionMock.mockReset();
    endSessionMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it("requires exact confirmation and leaves recent-auth failures visible and retryable", async () => {
    const onAccepted = vi.fn();
    submitMock
      .mockRejectedValueOnce(new Error("Recent authentication is required"))
      .mockResolvedValueOnce({
        request: acceptedRequest,
        statusCredential: "status-capability",
        recoveryCredential: "recovery-capability",
      });

    render(<AccountDeletionDialog onAccepted={onAccepted} />);
    fireEvent.click(screen.getByTestId("delete-account-trigger"));

    const confirmation = screen.getByLabelText("Type DELETE to confirm");
    const submit = screen.getByTestId(
      "delete-account-confirm",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(confirmation, { target: { value: "delete" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(confirmation, { target: { value: "DELETE" } });
    expect(submit.disabled).toBe(false);

    fireEvent.click(submit);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Recent authentication is required",
    );
    expect(submit.disabled).toBe(false);

    fireEvent.click(submit);
    await waitFor(() =>
      expect(onAccepted).toHaveBeenCalledWith(acceptedRequest),
    );
    expect(endSessionMock).toHaveBeenCalledOnce();
    expect(submitMock).toHaveBeenCalledTimes(2);
  });

  it("does not retire the session when the POST receipt is malformed", async () => {
    submitMock.mockRejectedValue(
      new Error("Account deletion response was malformed"),
    );
    render(<AccountDeletionDialog />);

    fireEvent.click(screen.getByTestId("delete-account-trigger"));
    fireEvent.change(screen.getByLabelText("Type DELETE to confirm"), {
      target: { value: "DELETE" },
    });
    fireEvent.click(screen.getByTestId("delete-account-confirm"));

    await waitFor(() => {
      expect(
        screen.getByText("Account deletion response was malformed"),
      ).toBeTruthy();
    });
    expect(endSessionMock).not.toHaveBeenCalled();
  });

  it("does not retire the session when the server refuses the confirmed request", async () => {
    submitMock.mockRejectedValue(
      new Error("Permanent account deletion is unavailable"),
    );
    render(<AccountDeletionDialog />);

    fireEvent.click(screen.getByTestId("delete-account-trigger"));
    fireEvent.change(screen.getByLabelText("Type DELETE to confirm"), {
      target: { value: "DELETE" },
    });
    fireEvent.click(screen.getByTestId("delete-account-confirm"));

    await screen.findByText("Permanent account deletion is unavailable");
    expect(endSessionMock).not.toHaveBeenCalled();
  });
});
