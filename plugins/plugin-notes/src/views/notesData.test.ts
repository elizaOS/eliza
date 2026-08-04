/**
 * Verifies browser mutations use the shared per-view interaction broker and
 * reject malformed broker envelopes before they can enter React state.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  fetchWithCsrf: vi.fn(),
}));

vi.mock("@elizaos/ui/api/csrf-client", () => ({
  fetchWithCsrf: transport.fetchWithCsrf,
}));

import { interact } from "./notesData.js";

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
  transport.fetchWithCsrf.mockReset();
});

describe("Notes browser interaction broker", () => {
  it("routes note capabilities through the Notes view broker", async () => {
    transport.fetchWithCsrf.mockResolvedValueOnce(brokerResponse(4));

    await expect(
      interact("create-note", { title: "Brokered note" }),
    ).resolves.toMatchObject({ success: true, state: { revision: 4 } });

    expect(transport.fetchWithCsrf).toHaveBeenCalledWith(
      "/api/views/notes/interact",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          capability: "create-note",
          params: { title: "Brokered note" },
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
