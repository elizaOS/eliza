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
    phase: "recovery_window",
    requestedAt: "2026-08-22T00:00:00.000Z",
    recoveryEndsAt: "2026-08-29T00:00:00.000Z",
    scheduledDeletionAt: "2026-08-29T00:00:00.000Z",
    completedAt: null,
    identityDeactivated: true,
    canCancel: true,
    canExport: true,
    nextPollAfterMs: null,
    progress: null,
    export: {
      status: "not_requested",
      downloadUrl: null,
      expiresAt: null,
    },
    actionRequiredCode: null,
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
      request({ phase: "cancelled", canCancel: false }),
    ),
    requestExport: vi.fn(async () =>
      request({
        export: { status: "preparing", downloadUrl: null, expiresAt: null },
      }),
    ),
    ...overrides,
  };
}

afterEach(cleanup);

describe("AndroidCloudSettings", () => {
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

    fireEvent.click(
      await screen.findByRole("button", { name: "Delete account & data" }),
    );
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

    fireEvent.click(
      await screen.findByRole("button", { name: "Delete account & data" }),
    );
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

  it("requires exact KEEP before cancelling inside the recovery window", async () => {
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
      target: { value: "KEEP" },
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
  });

  it("opens only an HTTPS export in the external browser", () => {
    const openExternal = vi.fn();
    render(
      <AndroidCloudSettings
        initialRequest={request({
          export: {
            status: "ready",
            downloadUrl: "https://downloads.eliza.app/export/opaque",
            expiresAt: "2026-08-23T00:00:00.000Z",
          },
        })}
        lifecycle={lifecycle()}
        onBack={vi.fn()}
        onDeletionReserved={vi.fn()}
        onSignOut={vi.fn()}
        openExternal={openExternal}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Download data export" }),
    );
    expect(openExternal).toHaveBeenCalledWith(
      "https://downloads.eliza.app/export/opaque",
    );
  });
});
