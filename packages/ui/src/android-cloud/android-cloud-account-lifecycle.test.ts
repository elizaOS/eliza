/** Security and replay coverage for the canonical Android lifecycle adapter. */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  CapacitorHttp: { request: vi.fn() },
  registerPlugin: vi.fn(() => ({})),
}));

vi.mock("../api/client-cloud", () => ({
  getCloudAuthToken: vi.fn(() => null),
}));

import type {
  AccountDeletionRequestDto,
  AccountDeletionStatus,
} from "./account-deletion-contract";
import { createAndroidCloudAccountLifecycle } from "./android-cloud-account-lifecycle";

const API_BASE = "https://api.eliza.app";
const APP_BASE = "https://cloud.eliza.app";
const STATUS_CREDENTIAL = "s".repeat(43);
const RECOVERY_CREDENTIAL = "r".repeat(43);

type RequestInput = {
  url: string;
  method: "GET" | "POST" | "DELETE";
  headers: Record<string, string>;
  data?: Record<string, unknown>;
  disableRedirects: boolean;
};

function requestDto(
  status: AccountDeletionStatus = "recovery",
): AccountDeletionRequestDto {
  const terminal = status === "completed" || status === "canceled";
  const canceled = status === "canceled";
  const canCancel = status === "reserved" || status === "recovery";
  const nextAction =
    status === "reserved"
      ? "wait_for_export"
      : status === "recovery"
        ? "download_export_or_cancel"
        : status === "action_required"
          ? "contact_support"
          : terminal
            ? "none"
            : "wait_for_reconciliation";
  return {
    requestId: "receipt-1",
    status,
    requestedAt: "2026-08-25T00:00:00.000Z",
    recoveryExpiresAt:
      status === "recovery" ? "2026-09-24T00:00:00.000Z" : null,
    scheduledDeletionAt: "2026-09-24T00:00:00.000Z",
    irreversibleAt: status === "completed" ? "2026-09-24T00:00:00.000Z" : null,
    completedAt: status === "completed" ? "2026-09-25T00:00:00.000Z" : null,
    identityDeactivated: !canceled,
    accessState:
      status === "completed" ? "erased" : canceled ? "active" : "fenced",
    canCancel,
    nextAction,
    export: null,
  };
}

function secureStore(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  return {
    values,
    plugin: {
      get: vi.fn(async ({ slot }: { slot: string }) => ({
        value: values.get(slot) ?? null,
      })),
      set: vi.fn(async ({ slot, value }: { slot: string; value: string }) => {
        values.set(slot, value);
      }),
      remove: vi.fn(async ({ slot }: { slot: string }) => {
        values.delete(slot);
      }),
    },
  };
}

function clientOptions(overrides: Record<string, unknown> = {}) {
  return {
    apiBase: API_BASE,
    appBase: APP_BASE,
    readAuthToken: () => "bearer-token",
    randomBytes: () => Uint8Array.from({ length: 32 }, (_, index) => index),
    playExport: { saveExport: vi.fn(async () => ({ saved: true })) },
    ...overrides,
  };
}

describe("Android account lifecycle transport", () => {
  beforeEach(() => vi.clearAllMocks());

  it("persists and reuses one admission credential after a lost response", async () => {
    const secure = secureStore();
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({
        status: 202,
        data: {
          request: requestDto(),
          statusCredential: STATUS_CREDENTIAL,
          recoveryCredential: RECOVERY_CREDENTIAL,
        },
      });
    const lifecycle = createAndroidCloudAccountLifecycle(
      clientOptions({ secureCredentials: secure.plugin, request }),
    );

    await expect(lifecycle.requestDeletion()).rejects.toThrow("response lost");
    await expect(lifecycle.requestDeletion()).resolves.toMatchObject({
      status: "recovery",
    });

    const first = request.mock.calls[0]?.[0].data;
    const second = request.mock.calls[1]?.[0].data;
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      confirmation: "DELETE",
      admissionCredential: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(secure.values.get("account_deletion_status")).toBe(
      STATUS_CREDENTIAL,
    );
    expect(secure.values.get("account_deletion_recovery")).toBe(
      RECOVERY_CREDENTIAL,
    );
    expect(secure.values.has("account_deletion_admission")).toBe(false);
  });

  it("coalesces concurrent deletion submissions into one reservation", async () => {
    const secure = secureStore();
    let resolveRequest!: (value: {
      status: number;
      data: Record<string, unknown>;
    }) => void;
    const request = vi.fn(
      async () =>
        await new Promise<{
          status: number;
          data: Record<string, unknown>;
        }>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const lifecycle = createAndroidCloudAccountLifecycle(
      clientOptions({ secureCredentials: secure.plugin, request }),
    );

    const first = lifecycle.requestDeletion();
    const second = lifecycle.requestDeletion();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    resolveRequest({
      status: 202,
      data: {
        request: requestDto(),
        statusCredential: STATUS_CREDENTIAL,
        recoveryCredential: RECOVERY_CREDENTIAL,
      },
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      requestDto(),
      requestDto(),
    ]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(secure.values.get("account_deletion_status")).toBe(
      STATUS_CREDENTIAL,
    );
    expect(secure.values.get("account_deletion_recovery")).toBe(
      RECOVERY_CREDENTIAL,
    );
  });

  it("CAS-invalidates only the rejected status capability", async () => {
    const secure = secureStore({
      account_deletion_status: STATUS_CREDENTIAL,
      account_deletion_recovery: RECOVERY_CREDENTIAL,
    });
    const request = vi.fn(async (_options: RequestInput) => ({
      status: 401,
      data: { code: "STATUS_CREDENTIAL_INVALID" },
    }));
    const lifecycle = createAndroidCloudAccountLifecycle(
      clientOptions({
        secureCredentials: secure.plugin,
        readAuthToken: () => null,
        request,
      }),
    );

    await expect(lifecycle.getStatus()).resolves.toBeNull();
    expect(request.mock.calls[0]?.[0].headers).toMatchObject({
      "X-Account-Deletion-Status": STATUS_CREDENTIAL,
    });
    expect(secure.values.has("account_deletion_status")).toBe(false);
    expect(secure.values.get("account_deletion_recovery")).toBe(
      RECOVERY_CREDENTIAL,
    );
  });

  it("treats a public route 404 as an outage without deleting either secret", async () => {
    const secure = secureStore({
      account_deletion_status: STATUS_CREDENTIAL,
      account_deletion_recovery: RECOVERY_CREDENTIAL,
    });
    const lifecycle = createAndroidCloudAccountLifecycle(
      clientOptions({
        secureCredentials: secure.plugin,
        readAuthToken: () => null,
        request: vi.fn(async () => ({ status: 404, data: {} })),
      }),
    );

    await expect(lifecycle.getStatus()).rejects.toMatchObject({
      code: "HTTP_404",
    });
    expect(secure.values.get("account_deletion_status")).toBe(
      STATUS_CREDENTIAL,
    );
    expect(secure.values.get("account_deletion_recovery")).toBe(
      RECOVERY_CREDENTIAL,
    );
  });

  it("uses public recovery authority and clears it when canceling begins", async () => {
    const secure = secureStore({
      account_deletion_recovery: RECOVERY_CREDENTIAL,
    });
    const request = vi.fn(async (_options: RequestInput) => ({
      status: 202,
      data: { request: requestDto("canceling") },
    }));
    const lifecycle = createAndroidCloudAccountLifecycle(
      clientOptions({ secureCredentials: secure.plugin, request }),
    );

    await expect(lifecycle.cancelDeletion()).resolves.toMatchObject({
      status: "canceling",
      accessState: "fenced",
    });
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      method: "DELETE",
      headers: {
        "X-Account-Deletion-Recovery": RECOVERY_CREDENTIAL,
      },
      data: { confirmation: "CANCEL DELETION" },
    });
    expect(secure.values.has("account_deletion_recovery")).toBe(false);
  });

  it("passes recovery authority only to the native export saver", async () => {
    const secure = secureStore({
      account_deletion_recovery: RECOVERY_CREDENTIAL,
    });
    const saveExport = vi.fn(async () => ({ saved: true }));
    const lifecycle = createAndroidCloudAccountLifecycle(
      clientOptions({
        secureCredentials: secure.plugin,
        playExport: { saveExport },
        request: vi.fn(),
      }),
    );

    await expect(lifecycle.downloadExport()).resolves.toBe(true);
    expect(saveExport).toHaveBeenCalledWith({
      apiBase: API_BASE,
      appOrigin: APP_BASE,
      recoveryCredential: RECOVERY_CREDENTIAL,
    });
  });
});
