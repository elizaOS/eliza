/** Proves deletion capabilities survive logout while confirmed success retires all local authority. */
// @vitest-environment jsdom

import { getElizaApiToken, setElizaApiToken } from "@elizaos/shared";
import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../../../api";
import { getBootConfig, setBootConfig } from "../../../config/boot-config";
import {
  loadAgentProfileRegistry,
  saveAgentProfileRegistry,
} from "../../../state/agent-profiles";
import {
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "../../../state/persistence";

const apiMock = vi.hoisted(() => vi.fn());
const apiFetchMock = vi.hoisted(() => vi.fn());
const statusCredential = "s".repeat(43);
const recoveryCredential = "r".repeat(43);

vi.mock("../../lib/api-client", () => ({
  api: apiMock,
  apiFetch: apiFetchMock,
}));

import {
  AccountDeletionClientError,
  cancelAccountDeletion,
  downloadAccountDeletionExport,
  endLocalSessionAfterDeletion,
  readAccountDeletionStatus,
  submitAccountDeletion,
} from "./account-deletion-client";

const request = {
  requestId: "33333333-3333-4333-8333-333333333333",
  status: "recovery" as const,
  requestedAt: "2026-08-22T12:00:00.000Z",
  recoveryExpiresAt: "2026-09-21T12:00:00.000Z",
  scheduledDeletionAt: "2026-09-21T12:00:00.000Z",
  irreversibleAt: null,
  completedAt: null,
  identityDeactivated: true,
  accessState: "fenced" as const,
  canCancel: true,
  nextAction: "download_export_or_cancel" as const,
  export: null,
};
const pendingRequest = {
  ...request,
  status: "pending_activation" as const,
  identityDeactivated: false,
  accessState: "active" as const,
  canCancel: false,
  nextAction: "confirm_recovery_package" as const,
};

describe("account deletion capability client", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiFetchMock.mockReset();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("durably stores separate status and recovery capabilities before session revocation", async () => {
    apiMock.mockResolvedValueOnce({
      request: pendingRequest,
      statusCredential,
      recoveryCredential,
    });
    apiMock.mockResolvedValueOnce({ request });

    await submitAccountDeletion();

    expect(apiMock).toHaveBeenCalledWith("/api/v1/me/account-deletion", {
      method: "POST",
      json: {
        confirmation: "DELETE",
        admissionCredential: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      },
    });
    expect(apiMock).toHaveBeenCalledWith("/api/public/account-deletion", {
      method: "PATCH",
      skipAuth: true,
      headers: { "X-Account-Deletion-Recovery": recoveryCredential },
      json: { confirmation: "ACTIVATE DELETION" },
    });
    expect(
      window.localStorage.getItem("eliza.account-deletion.status.v1"),
    ).toBe(statusCredential);
    expect(
      window.localStorage.getItem("eliza.account-deletion.recovery.v1"),
    ).toBe(recoveryCredential);
    expect(
      window.localStorage.getItem("eliza.account-deletion.admission.v1"),
    ).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
  });

  it("reuses the precommitted admission credential when the accepted response is lost", async () => {
    apiMock.mockRejectedValueOnce(new TypeError("network response lost"));
    await expect(submitAccountDeletion()).rejects.toThrow(
      "network response lost",
    );
    const retained = window.localStorage.getItem(
      "eliza.account-deletion.admission.v1",
    );
    expect(retained).toMatch(/^[A-Za-z0-9_-]{43}$/);

    apiMock.mockResolvedValueOnce({
      request: pendingRequest,
      statusCredential,
      recoveryCredential,
    });
    apiMock.mockResolvedValueOnce({ request });
    await expect(submitAccountDeletion()).resolves.toMatchObject({ request });
    expect(apiMock.mock.calls[0]?.[1]).toMatchObject({
      json: { admissionCredential: retained },
    });
    expect(apiMock.mock.calls[1]?.[1]).toMatchObject({
      json: { admissionCredential: retained },
    });
    expect(apiMock.mock.calls[2]?.[1]).toMatchObject({
      method: "PATCH",
      headers: { "X-Account-Deletion-Recovery": recoveryCredential },
    });
    expect(
      window.localStorage.getItem("eliza.account-deletion.admission.v1"),
    ).toBeNull();
  });

  it("recovers accepted capabilities after response loss and sessionStorage loss", async () => {
    apiMock.mockRejectedValueOnce(new TypeError("network response lost"));
    await expect(submitAccountDeletion()).rejects.toThrow(
      "network response lost",
    );
    const retained = window.localStorage.getItem(
      "eliza.account-deletion.admission.v1",
    );
    expect(retained).toMatch(/^[A-Za-z0-9_-]{43}$/);

    window.sessionStorage.clear();
    apiMock.mockResolvedValueOnce({
      request: pendingRequest,
      statusCredential,
      recoveryCredential,
    });
    apiMock.mockResolvedValueOnce({ request });

    await expect(readAccountDeletionStatus()).resolves.toEqual(request);
    expect(apiMock).toHaveBeenNthCalledWith(2, "/api/public/account-deletion", {
      method: "POST",
      skipAuth: true,
      json: { confirmation: "DELETE", admissionCredential: retained },
    });
    expect(apiMock).toHaveBeenLastCalledWith("/api/public/account-deletion", {
      method: "PATCH",
      skipAuth: true,
      headers: { "X-Account-Deletion-Recovery": recoveryCredential },
      json: { confirmation: "ACTIVATE DELETION" },
    });
    expect(
      window.localStorage.getItem("eliza.account-deletion.status.v1"),
    ).toBe(statusCredential);
    expect(
      window.localStorage.getItem("eliza.account-deletion.recovery.v1"),
    ).toBe(recoveryCredential);
    expect(
      window.localStorage.getItem("eliza.account-deletion.admission.v1"),
    ).toBeNull();
  });

  it("fails before request admission when durable capability storage is unavailable", async () => {
    const originalSetItem = Storage.prototype.setItem;
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key === "eliza.account-deletion.admission.v1") {
          throw new DOMException("storage denied", "SecurityError");
        }
        return originalSetItem.call(this, key, value);
      });

    try {
      await expect(submitAccountDeletion()).rejects.toMatchObject({
        code: "ACCOUNT_DELETION_CAPABILITY_STORAGE_UNAVAILABLE",
      });
    } finally {
      setItem.mockRestore();
    }

    expect(apiMock).not.toHaveBeenCalled();
  });

  it("does not activate when storage evicts a capability before exact read-back", async () => {
    apiMock.mockResolvedValueOnce({
      request: pendingRequest,
      statusCredential,
      recoveryCredential,
    });
    const originalSetItem = Storage.prototype.setItem;
    const originalRemoveItem = Storage.prototype.removeItem;
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        originalSetItem.call(this, key, value);
        if (key === "eliza.account-deletion.recovery.v1") {
          originalRemoveItem.call(this, key);
        }
      });

    try {
      await expect(submitAccountDeletion()).rejects.toMatchObject({
        code: "ACCOUNT_DELETION_CAPABILITY_STORAGE_UNAVAILABLE",
      });
    } finally {
      setItem.mockRestore();
    }

    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    expect(
      window.localStorage.getItem("eliza.account-deletion.admission.v1"),
    ).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("retains admission authority when accepted capability persistence is interrupted", async () => {
    apiMock.mockResolvedValueOnce({
      request: pendingRequest,
      statusCredential,
      recoveryCredential,
    });
    const originalSetItem = Storage.prototype.setItem;
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key === "eliza.account-deletion.recovery.v1") {
          throw new DOMException("storage quota changed", "QuotaExceededError");
        }
        return originalSetItem.call(this, key, value);
      });

    try {
      await expect(submitAccountDeletion()).rejects.toBeInstanceOf(
        AccountDeletionClientError,
      );
    } finally {
      setItem.mockRestore();
    }
    const retained = window.localStorage.getItem(
      "eliza.account-deletion.admission.v1",
    );
    expect(retained).toMatch(/^[A-Za-z0-9_-]{43}$/);

    apiMock.mockResolvedValueOnce({
      request: pendingRequest,
      statusCredential,
      recoveryCredential,
    });
    apiMock.mockResolvedValueOnce({ request });
    await expect(readAccountDeletionStatus()).resolves.toEqual(request);
    expect(apiMock).toHaveBeenNthCalledWith(2, "/api/public/account-deletion", {
      method: "POST",
      skipAuth: true,
      json: { confirmation: "DELETE", admissionCredential: retained },
    });
    expect(apiMock).toHaveBeenLastCalledWith("/api/public/account-deletion", {
      method: "PATCH",
      skipAuth: true,
      headers: { "X-Account-Deletion-Recovery": recoveryCredential },
      json: { confirmation: "ACTIVATE DELETION" },
    });
    expect(
      window.localStorage.getItem("eliza.account-deletion.recovery.v1"),
    ).toBe(recoveryCredential);
  });

  it("replays activation after a lost acknowledgement without losing the recovery package", async () => {
    apiMock.mockResolvedValueOnce({
      request: pendingRequest,
      statusCredential,
      recoveryCredential,
    });
    apiMock.mockRejectedValueOnce(
      new TypeError("activation acknowledgement lost"),
    );

    await expect(submitAccountDeletion()).rejects.toThrow(
      "activation acknowledgement lost",
    );
    expect(
      window.localStorage.getItem("eliza.account-deletion.admission.v1"),
    ).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      window.localStorage.getItem("eliza.account-deletion.recovery.v1"),
    ).toBe(recoveryCredential);

    window.sessionStorage.clear();
    apiMock.mockResolvedValueOnce({ request });
    await expect(readAccountDeletionStatus()).resolves.toEqual(request);

    const activationCalls = apiMock.mock.calls.filter(
      ([path, options]) =>
        path === "/api/public/account-deletion" &&
        (options as { method?: string })?.method === "PATCH",
    );
    expect(activationCalls).toHaveLength(2);
    expect(activationCalls[0]?.[1]).toMatchObject({
      headers: { "X-Account-Deletion-Recovery": recoveryCredential },
    });
    expect(activationCalls[1]?.[1]).toMatchObject({
      headers: { "X-Account-Deletion-Recovery": recoveryCredential },
    });
    expect(
      window.localStorage.getItem("eliza.account-deletion.admission.v1"),
    ).toBeNull();
  });

  it("reads post-session status only through the header capability", async () => {
    window.localStorage.setItem(
      "eliza.account-deletion.status.v1",
      statusCredential,
    );
    window.localStorage.setItem(
      "eliza.account-deletion.recovery.v1",
      recoveryCredential,
    );
    apiMock.mockResolvedValueOnce({ request });

    await expect(readAccountDeletionStatus()).resolves.toEqual(request);
    expect(apiMock).toHaveBeenCalledWith("/api/public/account-deletion", {
      skipAuth: true,
      headers: { "X-Account-Deletion-Status": statusCredential },
    });
  });

  it("does not infer second-device authority from public state or identifiers", async () => {
    window.localStorage.clear();
    window.sessionStorage.clear();

    await expect(readAccountDeletionStatus()).resolves.toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("uses and consumes the separate recovery capability for exact undo", async () => {
    window.localStorage.setItem(
      "eliza.account-deletion.status.v1",
      statusCredential,
    );
    window.localStorage.setItem(
      "eliza.account-deletion.recovery.v1",
      recoveryCredential,
    );
    apiMock.mockResolvedValueOnce({
      request: {
        ...request,
        status: "canceled",
        accessState: "active",
        canCancel: false,
        nextAction: "none",
      },
    });

    await cancelAccountDeletion();

    expect(apiMock).toHaveBeenCalledWith("/api/public/account-deletion", {
      method: "DELETE",
      skipAuth: true,
      headers: { "X-Account-Deletion-Recovery": recoveryCredential },
      json: { confirmation: "CANCEL DELETION" },
    });
    expect(
      window.localStorage.getItem("eliza.account-deletion.recovery.v1"),
    ).toBeNull();
    expect(
      window.localStorage.getItem("eliza.account-deletion.status.v1"),
    ).toBe(statusCredential);
  });

  it("retains recovery authority while cancellation is still reconciling", async () => {
    window.localStorage.setItem(
      "eliza.account-deletion.recovery.v1",
      recoveryCredential,
    );
    apiMock.mockResolvedValueOnce({
      request: {
        ...request,
        status: "canceling",
        accessState: "fenced",
        canCancel: false,
        nextAction: "wait_for_reconciliation",
      },
    });

    await expect(cancelAccountDeletion()).resolves.toMatchObject({
      status: "canceling",
    });
    expect(
      window.localStorage.getItem("eliza.account-deletion.recovery.v1"),
    ).toBe(recoveryCredential);
  });

  it("downloads export bytes with the recovery capability and verifies the digest header", async () => {
    window.localStorage.setItem(
      "eliza.account-deletion.recovery.v1",
      recoveryCredential,
    );
    apiFetchMock.mockResolvedValueOnce(
      new Response('{"export":true}', {
        headers: {
          "Content-Disposition": 'attachment; filename="account-export.json"',
          "Content-Type": "application/json",
          "X-Account-Deletion-Export-SHA256":
            "4c258778fd8b758646f4f157098fcd82f65df0c6fe924fecac710d0c94d3de12",
        },
      }),
    );

    const download = await downloadAccountDeletionExport();

    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/public/account-deletion/export",
      {
        method: "POST",
        skipAuth: true,
        headers: { "X-Account-Deletion-Recovery": recoveryCredential },
        json: { confirmation: "EXPORT MY DATA" },
      },
    );
    expect(download.filename).toBe("account-export.json");
    expect(download.contentDigest).toBe(
      "4c258778fd8b758646f4f157098fcd82f65df0c6fe924fecac710d0c94d3de12",
    );
    expect(await download.blob.text()).toBe('{"export":true}');
  });

  it("fails closed when export bytes do not match the receipt digest", async () => {
    window.localStorage.setItem(
      "eliza.account-deletion.recovery.v1",
      recoveryCredential,
    );
    apiFetchMock.mockResolvedValueOnce(
      new Response('{"export":true}', {
        headers: {
          "Content-Disposition": 'attachment; filename="account-export.json"',
          "X-Account-Deletion-Export-SHA256": "a".repeat(64),
        },
      }),
    );

    await expect(downloadAccountDeletionExport()).rejects.toThrow(
      "do not match the server receipt",
    );
  });

  it("rejects malformed accepted receipts before persisting either capability", async () => {
    apiMock.mockResolvedValueOnce({
      request: { ...pendingRequest, requestedAt: "not-an-iso-timestamp" },
      statusCredential,
      recoveryCredential,
    });

    await expect(submitAccountDeletion()).rejects.toThrow(
      "Account deletion receipt was malformed",
    );
    expect(
      window.localStorage.getItem("eliza.account-deletion.status.v1"),
    ).toBeNull();
    expect(
      window.localStorage.getItem("eliza.account-deletion.recovery.v1"),
    ).toBeNull();
    expect(
      window.localStorage.getItem("eliza.account-deletion.admission.v1"),
    ).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("rejects incompatible terminal cancellation projections", async () => {
    window.localStorage.setItem(
      "eliza.account-deletion.status.v1",
      statusCredential,
    );
    window.localStorage.setItem(
      "eliza.account-deletion.recovery.v1",
      recoveryCredential,
    );
    apiMock.mockResolvedValueOnce({
      request: {
        ...request,
        status: "canceled",
        accessState: "fenced",
        canCancel: false,
        nextAction: "wait_for_reconciliation",
      },
    });

    await expect(readAccountDeletionStatus()).rejects.toThrow(
      "Account deletion receipt was malformed",
    );
  });

  it("retains recovery authority when cancellation response validation fails", async () => {
    window.localStorage.setItem(
      "eliza.account-deletion.recovery.v1",
      recoveryCredential,
    );
    apiMock.mockResolvedValueOnce({
      request: { ...request, status: "unknown" },
    });

    await expect(cancelAccountDeletion()).rejects.toThrow(
      "Account deletion receipt was malformed",
    );
    expect(
      window.localStorage.getItem("eliza.account-deletion.recovery.v1"),
    ).toBe(recoveryCredential);
  });

  it("migrates legacy session capabilities into durable storage", async () => {
    window.sessionStorage.setItem(
      "eliza.account-deletion.status.v1",
      statusCredential,
    );
    window.sessionStorage.setItem(
      "eliza.account-deletion.recovery.v1",
      recoveryCredential,
    );
    apiMock.mockResolvedValueOnce({ request });

    await expect(readAccountDeletionStatus()).resolves.toEqual(request);
    expect(
      window.localStorage.getItem("eliza.account-deletion.status.v1"),
    ).toBe(statusCredential);
    expect(
      window.localStorage.getItem("eliza.account-deletion.recovery.v1"),
    ).toBe(recoveryCredential);
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe("endLocalSessionAfterDeletion", () => {
  it("retires every canonical Steward and owner-key mirror before returning", async () => {
    const sharedBase =
      "https://api.eliza.app/api/v1/eliza/agents/deleted-account-agent";
    localStorage.clear();
    sessionStorage.clear();
    setBootConfig({ branding: {}, apiBase: sharedBase });
    client.setToken("eliza_deleted-owner-key");
    setElizaApiToken("eliza_deleted-owner-key");
    localStorage.setItem(STEWARD_TOKEN_KEY, "deleted.steward.jwt");
    localStorage.setItem("eliza.account-deletion.status.v1", statusCredential);
    localStorage.setItem(
      "eliza.account-deletion.recovery.v1",
      recoveryCredential,
    );
    savePersistedActiveServer({
      id: "cloud:deleted-account-agent",
      kind: "cloud",
      label: "Deleted account agent",
      apiBase: sharedBase,
      accessToken: "eliza_deleted-owner-key",
    });
    saveAgentProfileRegistry({
      version: 1,
      activeProfileId: "deleted-account-profile",
      profiles: [
        {
          id: "deleted-account-profile",
          kind: "cloud",
          label: "Deleted account agent",
          apiBase: sharedBase,
          accessToken: "eliza_deleted-owner-key",
          createdAt: "2026-08-23T00:00:00.000Z",
        },
      ],
    });
    const sessionSync = vi.fn();
    window.addEventListener("steward-token-sync", sessionSync);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    try {
      await endLocalSessionAfterDeletion();
    } finally {
      window.removeEventListener("steward-token-sync", sessionSync);
      fetchSpy.mockRestore();
    }

    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
    expect(getBootConfig().apiToken).toBeUndefined();
    expect(getElizaApiToken()).toBeUndefined();
    expect(client.apiToken).toBeNull();
    expect(loadPersistedActiveServer()).toBeNull();
    expect(loadAgentProfileRegistry()).toEqual({
      version: 1,
      activeProfileId: null,
      profiles: [],
    });
    expect(localStorage.getItem("eliza.account-deletion.status.v1")).toBe(
      statusCredential,
    );
    expect(localStorage.getItem("eliza.account-deletion.recovery.v1")).toBe(
      recoveryCredential,
    );
    expect(sessionSync).toHaveBeenCalled();
  });
});
