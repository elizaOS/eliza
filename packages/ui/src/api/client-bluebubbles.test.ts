/**
 * Focused transport regression for the canonical BlueBubbles setup contract.
 * Covers the three acceptance branches: unwrapping detail, 404→unavailable,
 * and preserving non-404 errors. No live bridge.
 */
// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { ElizaClient } from "./client-base";
import { ApiError } from "./client-types-core";
import "./client-skills";

function makeClient() {
  return new ElizaClient("http://localhost:3000", "test-token");
}

describe("getBlueBubblesStatus canonical contract", () => {
  it("requests the canonical /api/setup/bluebubbles/status and unwraps detail", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(client as unknown as { fetch: typeof client.fetch }, "fetch")
      .mockResolvedValue({
        connector: "bluebubbles",
        state: "paired",
        detail: {
          available: true,
          connected: true,
          webhookPath: "/webhooks/bluebubbles",
        },
      } as unknown as Awaited<ReturnType<typeof client.fetch>>);

    const res = await client.getBlueBubblesStatus();

    expect(fetchSpy).toHaveBeenCalledWith("/api/setup/bluebubbles/status");
    expect(res).toEqual({
      available: true,
      connected: true,
      webhookPath: "/webhooks/bluebubbles",
    });
  });

  it("preserves reason when present and unwraps idle detail", async () => {
    const client = makeClient();
    vi.spyOn(
      client as unknown as { fetch: typeof client.fetch },
      "fetch",
    ).mockResolvedValue({
      connector: "bluebubbles",
      state: "idle",
      detail: {
        available: false,
        connected: false,
        webhookPath: "/webhooks/bluebubbles",
        reason: "bluebubbles service not registered",
      },
    } as unknown as Awaited<ReturnType<typeof client.fetch>>);

    const res = await client.getBlueBubblesStatus();
    expect(res).toEqual({
      available: false,
      connected: false,
      webhookPath: "/webhooks/bluebubbles",
      reason: "bluebubbles service not registered",
    });
  });

  it("translates the expected inactive-plugin 404 into unavailable status", async () => {
    const client = makeClient();
    vi.spyOn(
      client as unknown as { fetch: typeof client.fetch },
      "fetch",
    ).mockRejectedValue(
      new ApiError({
        kind: "http",
        path: "/api/setup/bluebubbles/status",
        status: 404,
        message: "Not Found",
      }),
    );

    const res = await client.getBlueBubblesStatus();
    expect(res).toEqual({
      available: false,
      connected: false,
      webhookPath: "/webhooks/bluebubbles",
      reason: "bluebubbles service not registered",
    });
  });

  it("preserves non-404 errors instead of masking them", async () => {
    const client = makeClient();
    const err = new ApiError({
      kind: "http",
      path: "/api/setup/bluebubbles/status",
      status: 500,
      message: "Internal",
    });
    vi.spyOn(
      client as unknown as { fetch: typeof client.fetch },
      "fetch",
    ).mockRejectedValue(err);

    await expect(client.getBlueBubblesStatus()).rejects.toBe(err);
  });

  it("throws when detail DTO is missing or malformed", async () => {
    const client = makeClient();
    vi.spyOn(
      client as unknown as { fetch: typeof client.fetch },
      "fetch",
    ).mockResolvedValue({
      connector: "bluebubbles",
      state: "paired",
    } as unknown as Awaited<ReturnType<typeof client.fetch>>);

    await expect(client.getBlueBubblesStatus()).rejects.toThrow(
      /Invalid BlueBubbles status response/,
    );
  });

  it("does not request the legacy /api/bluebubbles/status route", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(client as unknown as { fetch: typeof client.fetch }, "fetch")
      .mockResolvedValue({
        connector: "bluebubbles",
        state: "paired",
        detail: {
          available: true,
          connected: false,
          webhookPath: "/webhooks/bluebubbles",
        },
      } as unknown as Awaited<ReturnType<typeof client.fetch>>);

    await client.getBlueBubblesStatus();
    expect(fetchSpy).not.toHaveBeenCalledWith("/api/bluebubbles/status");
  });

  it("rethrows structured agent_not_found 404 instead of masking as inactive", async () => {
    const client = makeClient();
    const err = new ApiError({
      kind: "http",
      path: "/api/setup/bluebubbles/status",
      status: 404,
      message: "Not Found",
      code: "agent_not_found",
    });
    vi.spyOn(
      client as unknown as { fetch: typeof client.fetch },
      "fetch",
    ).mockRejectedValue(err);

    await expect(client.getBlueBubblesStatus()).rejects.toBe(err);
  });

  it("throws on wrong connector or unknown state", async () => {
    const client = makeClient();
    vi.spyOn(
      client as unknown as { fetch: typeof client.fetch },
      "fetch",
    ).mockResolvedValue({
      connector: "wrong",
      state: "paired",
      detail: {
        available: true,
        connected: true,
        webhookPath: "/webhooks/bluebubbles",
      },
    } as unknown as Awaited<ReturnType<typeof client.fetch>>);

    await expect(client.getBlueBubblesStatus()).rejects.toThrow(
      /bad connector\/state/,
    );

    vi.spyOn(
      client as unknown as { fetch: typeof client.fetch },
      "fetch",
    ).mockResolvedValue({
      connector: "bluebubbles",
      state: "unknown-state",
      detail: {
        available: true,
        connected: true,
        webhookPath: "/webhooks/bluebubbles",
      },
    } as unknown as Awaited<ReturnType<typeof client.fetch>>);

    await expect(client.getBlueBubblesStatus()).rejects.toThrow(
      /bad connector\/state/,
    );
  });
});
