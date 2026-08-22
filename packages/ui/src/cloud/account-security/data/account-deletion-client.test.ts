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

vi.mock("../../lib/api-client", () => ({
  api: apiMock,
  apiFetch: apiFetchMock,
}));

import {
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
  canCancel: true,
  nextAction: "download_export_or_cancel" as const,
  export: null,
};

describe("account deletion capability client", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiFetchMock.mockReset();
    window.sessionStorage.clear();
  });

  it("stores separate status and recovery capabilities before session revocation", async () => {
    apiMock.mockResolvedValueOnce({
      request,
      statusCredential: "status-capability",
      recoveryCredential: "recovery-capability",
    });

    await submitAccountDeletion();

    expect(apiMock).toHaveBeenCalledWith("/api/v1/me/account-deletion", {
      method: "POST",
      json: { confirmation: "DELETE" },
    });
    expect(
      window.sessionStorage.getItem("eliza.account-deletion.status.v1"),
    ).toBe("status-capability");
    expect(
      window.sessionStorage.getItem("eliza.account-deletion.recovery.v1"),
    ).toBe("recovery-capability");
  });

  it("reads post-session status only through the header capability", async () => {
    window.sessionStorage.setItem(
      "eliza.account-deletion.status.v1",
      "status-capability",
    );
    apiMock.mockResolvedValueOnce({ request });

    await expect(readAccountDeletionStatus()).resolves.toEqual(request);
    expect(apiMock).toHaveBeenCalledWith("/api/public/account-deletion", {
      skipAuth: true,
      headers: { "X-Account-Deletion-Status": "status-capability" },
    });
  });

  it("uses and consumes the separate recovery capability for exact undo", async () => {
    window.sessionStorage.setItem(
      "eliza.account-deletion.status.v1",
      "status-capability",
    );
    window.sessionStorage.setItem(
      "eliza.account-deletion.recovery.v1",
      "recovery-capability",
    );
    apiMock.mockResolvedValueOnce({
      request: { ...request, status: "canceled", canCancel: false },
    });

    await cancelAccountDeletion();

    expect(apiMock).toHaveBeenCalledWith("/api/public/account-deletion", {
      method: "DELETE",
      skipAuth: true,
      headers: { "X-Account-Deletion-Recovery": "recovery-capability" },
      json: { confirmation: "CANCEL DELETION" },
    });
    expect(
      window.sessionStorage.getItem("eliza.account-deletion.recovery.v1"),
    ).toBeNull();
    expect(
      window.sessionStorage.getItem("eliza.account-deletion.status.v1"),
    ).toBe("status-capability");
  });

  it("downloads export bytes with the recovery capability and verifies the digest header", async () => {
    window.sessionStorage.setItem(
      "eliza.account-deletion.recovery.v1",
      "recovery-capability",
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
        headers: { "X-Account-Deletion-Recovery": "recovery-capability" },
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
    window.sessionStorage.setItem(
      "eliza.account-deletion.recovery.v1",
      "recovery-capability",
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
    expect(sessionSync).toHaveBeenCalled();
  });
});
