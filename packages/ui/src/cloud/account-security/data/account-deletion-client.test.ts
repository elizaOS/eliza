/** Verifies deletion receipts and the real local authority teardown that follows confirmed success. */
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

vi.mock("../../lib/api-client", () => ({ api: apiMock }));

import {
  endLocalSessionAfterDeletion,
  getAccountDeletionStatus,
  submitAccountDeletion,
} from "./account-deletion-client";

beforeEach(() => apiMock.mockReset());

describe("getAccountDeletionStatus", () => {
  it("accepts each fail-closed availability state", async () => {
    apiMock.mockResolvedValueOnce({
      state: "lifecycle_unavailable",
      request: null,
      code: "LIFECYCLE_RESERVATION_REQUIRED",
      message: "Lifecycle reservation required",
    });

    await expect(getAccountDeletionStatus()).resolves.toMatchObject({
      state: "lifecycle_unavailable",
      request: null,
    });
    expect(apiMock).toHaveBeenCalledWith("/api/v1/me/account-deletion");
  });

  it("accepts a complete existing receipt", async () => {
    apiMock.mockResolvedValueOnce({
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

    await expect(getAccountDeletionStatus()).resolves.toMatchObject({
      state: "existing_request",
      request: { requestId: "request-1", identityDeactivated: false },
    });
  });

  it("rejects unknown states and incomplete receipts", async () => {
    apiMock.mockResolvedValueOnce({ state: "scheduled", request: null });
    await expect(getAccountDeletionStatus()).rejects.toThrow(
      "Account deletion availability response was malformed",
    );

    apiMock.mockResolvedValueOnce({
      state: "existing_request",
      request: { requestId: "request-1" },
    });
    await expect(getAccountDeletionStatus()).rejects.toThrow(
      "Account deletion receipt was malformed",
    );
  });
});

describe("submitAccountDeletion", () => {
  it("returns the parsed receipt from a complete envelope", async () => {
    apiMock.mockResolvedValueOnce({
      request: {
        requestId: "request-2",
        status: "scheduled",
        requestedAt: "2026-08-19T00:00:00.000Z",
        scheduledDeletionAt: "2026-09-18T00:00:00.000Z",
        identityDeactivated: true,
        completedAt: null,
      },
    });

    await expect(submitAccountDeletion()).resolves.toEqual({
      requestId: "request-2",
      status: "scheduled",
      requestedAt: "2026-08-19T00:00:00.000Z",
      scheduledDeletionAt: "2026-09-18T00:00:00.000Z",
      identityDeactivated: true,
      completedAt: null,
    });
    expect(apiMock).toHaveBeenCalledWith("/api/v1/me/account-deletion", {
      method: "POST",
      json: { confirmation: "DELETE" },
    });
  });

  it("rejects a malformed receipt instead of surfacing undefined fields", async () => {
    apiMock.mockResolvedValueOnce({ request: { requestId: "request-2" } });
    await expect(submitAccountDeletion()).rejects.toThrow(
      "Account deletion receipt was malformed",
    );

    apiMock.mockResolvedValueOnce({ requestId: "request-2" });
    await expect(submitAccountDeletion()).rejects.toThrow(
      "Account deletion receipt was malformed",
    );

    apiMock.mockResolvedValueOnce("accepted");
    await expect(submitAccountDeletion()).rejects.toThrow(
      "Account deletion receipt was malformed",
    );
  });

  it("rejects unknown receipt statuses, blank ids, and invalid timestamps", async () => {
    const request = {
      requestId: "request-2",
      status: "scheduled",
      requestedAt: "2026-08-19T00:00:00.000Z",
      scheduledDeletionAt: "2026-09-18T00:00:00.000Z",
      identityDeactivated: true,
      completedAt: null,
    };

    apiMock.mockResolvedValueOnce({
      request: { ...request, requestId: "  " },
    });
    await expect(submitAccountDeletion()).rejects.toThrow(
      "Account deletion receipt was malformed",
    );

    apiMock.mockResolvedValueOnce({
      request: { ...request, status: "unexpected" },
    });
    await expect(submitAccountDeletion()).rejects.toThrow(
      "Account deletion receipt was malformed",
    );

    apiMock.mockResolvedValueOnce({
      request: { ...request, scheduledDeletionAt: "not-a-date" },
    });
    await expect(submitAccountDeletion()).rejects.toThrow(
      "Account deletion receipt was malformed",
    );

    apiMock.mockResolvedValueOnce({
      request: { ...request, completedAt: "2026-09-18" },
    });
    await expect(submitAccountDeletion()).rejects.toThrow(
      "Account deletion receipt was malformed",
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
