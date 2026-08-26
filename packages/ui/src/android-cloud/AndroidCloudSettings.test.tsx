// @vitest-environment jsdom

/** Exercises Play-safe Settings, exact deletion confirmation, and recovery controls. */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AndroidCloudAccountLifecycleAdapter,
  AndroidCloudSettings,
} from "./AndroidCloudSettings";
import type { AccountDeletionRequestDto } from "./account-deletion-contract";

function request(
  overrides: Partial<AccountDeletionRequestDto> = {},
): AccountDeletionRequestDto {
  return {
    requestId: "receipt_android_opaque_1",
    status: "recovery",
    requestedAt: "2026-08-22T00:00:00.000Z",
    recoveryExpiresAt: "2026-09-21T00:00:00.000Z",
    scheduledDeletionAt: "2026-09-21T00:00:00.000Z",
    irreversibleAt: null,
    completedAt: null,
    identityDeactivated: true,
    accessState: "fenced",
    canCancel: true,
    nextAction: "download_export_or_cancel",
    export: {
      status: "building",
      readyAt: null,
      expiresAt: "2026-09-21T00:00:00.000Z",
      contentDigest: null,
    },
    ...overrides,
  };
}

function lifecycle(
  overrides: Partial<AndroidCloudAccountLifecycleAdapter> = {},
): AndroidCloudAccountLifecycleAdapter {
  return {
    getStatus: vi.fn(async () => null),
    requestDeletion: vi.fn(async () => request()),
    cancelDeletion: vi.fn(async () =>
      request({
        status: "canceled",
        identityDeactivated: false,
        accessState: "active",
        canCancel: false,
        nextAction: "none",
      }),
    ),
    downloadExport: vi.fn(async () => true),
    ...overrides,
  };
}

afterEach(cleanup);

describe("AndroidCloudSettings", () => {
  it("fails closed before confirmation when lifecycle admission is unavailable", async () => {
    const adapter = lifecycle({
      getAvailability: vi.fn(async () => ({
        state: "lifecycle_unavailable" as const,
        request: null,
        code: "LIFECYCLE_RESERVATION_REQUIRED" as const,
        message: "Lifecycle reservation required",
      })),
    });
    render(
      <AndroidCloudSettings
        lifecycle={adapter}
        onBack={vi.fn()}
        onDeletionReserved={vi.fn()}
        onSignOut={vi.fn()}
        openExternal={vi.fn()}
      />,
    );

    expect(
      await screen.findByText(/Account deletion is temporarily unavailable/),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Delete account & data",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("exposes standard Android permission settings and the public deletion page", async () => {
    const openAppSettings = vi.fn();
    const openExternal = vi.fn();
    render(
      <AndroidCloudSettings
        lifecycle={lifecycle()}
        onBack={vi.fn()}
        onDeletionReserved={vi.fn()}
        onSignOut={vi.fn()}
        openAppSettings={openAppSettings}
        openExternal={openExternal}
      />,
    );

    expect(
      await screen.findByRole("button", { name: "Open Android app settings" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByText("Checking deletion status…")).toBeNull(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open Android app settings" }),
    );
    expect(openAppSettings).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole("button", { name: "Deletion policy & web request" }),
    );
    expect(openExternal).toHaveBeenCalledWith(
      "https://eliza.app/account-deletion",
    );
  });

  it("requires acknowledgement plus exact DELETE before reserving deletion", async () => {
    const reserved = request();
    const adapter = lifecycle({
      requestDeletion: vi.fn(async () => reserved),
    });
    const onDeletionReserved = vi.fn();
    render(
      <AndroidCloudSettings
        lifecycle={adapter}
        onBack={vi.fn()}
        onDeletionReserved={onDeletionReserved}
        onSignOut={vi.fn()}
        openExternal={vi.fn()}
      />,
    );

    const deleteButton = await screen.findByRole("button", {
      name: "Delete account & data",
    });
    await waitFor(() =>
      expect((deleteButton as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(deleteButton);
    const confirm = screen.getByRole("button", {
      name: "Delete account",
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Type DELETE to confirm"), {
      target: { value: "DELETE" },
    });
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(confirm.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(confirm);
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(adapter.requestDeletion).toHaveBeenCalledTimes(1),
    );
    await vi.waitFor(() =>
      expect(onDeletionReserved).toHaveBeenCalledWith(reserved),
    );
  });

  it("turns transfer-required admission into an actionable ownership link", async () => {
    class TransferRequiredError extends Error {
      readonly code = "TRANSFER_REQUIRED";
    }
    const openExternal = vi.fn();
    const adapter = lifecycle({
      requestDeletion: vi.fn(async () => {
        throw new TransferRequiredError(
          "Transfer shared organization ownership before deleting.",
        );
      }),
    });
    render(
      <AndroidCloudSettings
        lifecycle={adapter}
        onBack={vi.fn()}
        onDeletionReserved={vi.fn()}
        onSignOut={vi.fn()}
        openExternal={openExternal}
      />,
    );

    const deleteButton = await screen.findByRole("button", {
      name: "Delete account & data",
    });
    await waitFor(() =>
      expect((deleteButton as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(deleteButton);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByLabelText("Type DELETE to confirm"), {
      target: { value: "DELETE" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
      await Promise.resolve();
    });

    const transfer = await screen.findByRole("button", {
      name: "Transfer shared organization ownership",
    });
    fireEvent.click(transfer);
    expect(openExternal).toHaveBeenCalledWith(
      "https://eliza.app/settings#cloud-organization",
    );
  });

  it("requires exact CANCEL DELETION before cancelling", async () => {
    const adapter = lifecycle();
    render(
      <AndroidCloudSettings
        initialRequest={request()}
        lifecycle={adapter}
        onBack={vi.fn()}
        onDeletionReserved={vi.fn()}
        onSignOut={vi.fn()}
        openExternal={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Keep my account" }));
    const confirm = screen.getByRole("button", {
      name: "Keep account",
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Confirmation"), {
      target: { value: "CANCEL DELETION" },
    });
    expect(confirm.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(confirm);
      await Promise.resolve();
    });

    await vi.waitFor(() =>
      expect(adapter.cancelDeletion).toHaveBeenCalledTimes(1),
    );
    expect(await screen.findByText("Deletion cancelled")).toBeTruthy();
    expect(
      screen.getByText(/Existing sessions and API keys remain revoked/),
    ).toBeTruthy();
  });

  it("keeps polling while cancellation cleanup is fenced", async () => {
    vi.useFakeTimers();
    try {
      const restored = request({
        status: "canceled",
        identityDeactivated: false,
        accessState: "active",
        canCancel: false,
        nextAction: "none",
      });
      const adapter = lifecycle({ getStatus: vi.fn(async () => restored) });
      render(
        <AndroidCloudSettings
          initialRequest={request({
            status: "canceling",
            accessState: "fenced",
            canCancel: false,
            nextAction: "wait_for_reconciliation",
          })}
          lifecycle={adapter}
          onBack={vi.fn()}
          onDeletionReserved={vi.fn()}
          onSignOut={vi.fn()}
          openExternal={vi.fn()}
        />,
      );

      expect(screen.getByText("Restoring account access")).toBeTruthy();
      expect(screen.getByText(/Account access stays fenced/)).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(adapter.getStatus).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Deletion cancelled")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("polls an existing request through the public-capable status path after logout", async () => {
    vi.useFakeTimers();
    try {
      const completed = request({
        status: "completed",
        completedAt: "2026-08-22T00:05:00.000Z",
        canCancel: false,
        nextAction: "none",
      });
      const getAvailability = vi.fn(async () => {
        throw new Error("authenticated bearer was cleared after reservation");
      });
      const getStatus = vi.fn(async () => completed);
      render(
        <AndroidCloudSettings
          initialRequest={request({ status: "reserved" })}
          lifecycle={lifecycle({ getAvailability, getStatus })}
          onBack={vi.fn()}
          onDeletionReserved={vi.fn()}
          onSignOut={vi.fn()}
          openExternal={vi.fn()}
        />,
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(getStatus).toHaveBeenCalledTimes(1);
      expect(getAvailability).not.toHaveBeenCalled();
      expect(screen.getByText("Deletion complete")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a status outage and retries the nonterminal reconciliation", async () => {
    vi.useFakeTimers();
    try {
      const restored = request({
        status: "canceled",
        identityDeactivated: false,
        accessState: "active",
        canCancel: false,
        nextAction: "none",
      });
      const getStatus = vi
        .fn<AndroidCloudAccountLifecycleAdapter["getStatus"]>()
        .mockRejectedValueOnce(new Error("Status temporarily unavailable"))
        .mockResolvedValueOnce(restored);
      render(
        <AndroidCloudSettings
          initialRequest={request({
            status: "canceling",
            accessState: "fenced",
            canCancel: false,
            nextAction: "wait_for_reconciliation",
          })}
          lifecycle={lifecycle({ getStatus })}
          onBack={vi.fn()}
          onDeletionReserved={vi.fn()}
          onSignOut={vi.fn()}
          openExternal={vi.fn()}
        />,
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(screen.getByRole("alert").textContent).toContain(
        "Status temporarily unavailable",
      );
      expect(screen.getByText("Restoring account access")).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(getStatus).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Deletion cancelled")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves a ready export through the native document flow", async () => {
    const adapter = lifecycle();
    render(
      <AndroidCloudSettings
        initialRequest={request({
          export: {
            status: "ready",
            readyAt: "2026-08-22T00:01:00.000Z",
            expiresAt: "2026-08-23T00:00:00.000Z",
            contentDigest: "a".repeat(64),
          },
        })}
        lifecycle={adapter}
        onBack={vi.fn()}
        onDeletionReserved={vi.fn()}
        onSignOut={vi.fn()}
        openExternal={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save data export" }));
      await Promise.resolve();
    });
    expect(adapter.downloadExport).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText("Export saved to the location you selected."),
    ).toBeTruthy();
  });
});
