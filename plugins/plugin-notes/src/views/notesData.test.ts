/**
 * Verifies browser mutations use the shared per-view interaction broker and
 * reject malformed broker envelopes before they can enter React state.
 */

import { ApiError } from "@elizaos/ui/api/client-types-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  clientFetch: vi.fn(),
  fetchWithCsrf: vi.fn(),
}));

vi.mock("@elizaos/ui/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/ui/api")>();
  return {
    ...actual,
    client: { fetch: transport.clientFetch },
  };
});

vi.mock("@elizaos/ui/api/csrf-client", () => ({
  fetchWithCsrf: transport.fetchWithCsrf,
}));

import { fetchNotesState, interact } from "./notesData.js";

function snapshot(revision: number) {
  return { notes: [], revision };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function brokerResponse(revision: number): Response {
  return jsonResponse({
    requestId: `request-${revision}`,
    success: true,
    result: {
      success: true,
      text: "Mutation complete.",
      state: snapshot(revision),
    },
  });
}

beforeEach(() => {
  transport.clientFetch.mockReset();
  transport.fetchWithCsrf.mockReset();
});

describe("Notes browser interaction broker", () => {
  it("preserves the real Shared capability envelope as a typed ApiError", async () => {
    const capabilityData = {
      success: false,
      code: "notes_runtime_unavailable",
      error:
        "Notes require a dedicated agent runtime; this shared agent does not have a persistent notes store.",
      capability: "notes",
      requiredExecutionTier: "dedicated-always",
      upgradeRequired: true,
      retryable: false,
    } as const;
    const capabilityError = new ApiError({
      kind: "http",
      path: "/api/notes/state",
      status: 503,
      code: capabilityData.code,
      message: capabilityData.error,
      data: capabilityData,
    });
    transport.clientFetch.mockRejectedValueOnce(capabilityError);

    let caught: unknown;
    try {
      await fetchNotesState();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({
      kind: "http",
      path: "/api/notes/state",
      status: 503,
      code: "notes_runtime_unavailable",
      message: capabilityData.error,
    });
    expect((caught as ApiError).data).toEqual(capabilityData);
  });

  it("loads and validates the Notes snapshot through the shared API client", async () => {
    transport.clientFetch.mockResolvedValueOnce({
      success: true,
      data: snapshot(7),
    });

    await expect(fetchNotesState()).resolves.toEqual(snapshot(7));
    expect(transport.clientFetch).toHaveBeenCalledWith("/api/notes/state", {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    expect(transport.fetchWithCsrf).not.toHaveBeenCalled();
  });

  it("forwards the mounted view lifecycle signal to the shared API client", async () => {
    const controller = new AbortController();
    transport.clientFetch.mockResolvedValueOnce({
      success: true,
      data: snapshot(8),
    });

    await expect(fetchNotesState(controller.signal)).resolves.toEqual(
      snapshot(8),
    );
    expect(transport.clientFetch).toHaveBeenCalledWith("/api/notes/state", {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  });

  it("routes note capabilities through the Notes view broker", async () => {
    transport.fetchWithCsrf.mockResolvedValueOnce(brokerResponse(4));

    await expect(
      interact("create-note", { content: "Brokered note" }),
    ).resolves.toMatchObject({ success: true, state: { revision: 4 } });

    expect(transport.fetchWithCsrf).toHaveBeenCalledWith(
      "/api/views/notes/interact",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          capability: "create-note",
          params: { content: "Brokered note" },
        }),
      }),
    );
  });

  it("rejects unknown capabilities before issuing a request", async () => {
    await expect(interact("invent-note")).rejects.toThrow(
      'Notes does not support capability "invent-note".',
    );
    expect(transport.fetchWithCsrf).not.toHaveBeenCalled();
  });

  it("surfaces a broker failure without accepting a partial snapshot", async () => {
    transport.fetchWithCsrf.mockResolvedValueOnce(
      jsonResponse({
        requestId: "request-failed",
        success: false,
        result: {
          success: false,
          text: "Note title is required.",
        },
      }),
    );

    await expect(interact("create-note", {})).rejects.toThrow(
      "Note title is required.",
    );
  });

  it("rejects a malformed broker failure result", async () => {
    transport.fetchWithCsrf.mockResolvedValueOnce(
      jsonResponse({
        requestId: "request-failed",
        success: false,
        result: { text: "Untrusted detail without a failure marker." },
      }),
    );

    await expect(interact("clear-notes")).rejects.toThrow(
      "Notes returned an invalid broker failure result.",
    );
  });

  it("preserves broker HTTP error details", async () => {
    transport.fetchWithCsrf.mockResolvedValueOnce(
      jsonResponse({ error: "Capability is not declared for Notes." }, 400),
    );

    await expect(interact("create-note", {})).rejects.toThrow(
      "Capability is not declared for Notes.",
    );
  });

  it("rejects a successful broker result with a malformed state", async () => {
    transport.fetchWithCsrf.mockResolvedValueOnce(
      jsonResponse({
        requestId: "request-malformed",
        success: true,
        result: {
          success: true,
          text: "Mutation complete.",
          state: { ...snapshot(6), revision: "6" },
        },
      }),
    );

    await expect(interact("clear-notes")).rejects.toThrow(
      "Notes state revision is invalid.",
    );
  });
});
