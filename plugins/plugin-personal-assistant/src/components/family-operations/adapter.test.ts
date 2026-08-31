/** HTTP contract tests for Family Operations calendar conflict mutations. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultFamilyOperationsAdapter } from "./adapter.js";

afterEach(() => vi.unstubAllGlobals());

describe("defaultFamilyOperationsAdapter", () => {
  it("sends the canonical conflict strategy and optimistic-lock timestamp", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ outcome: "clean" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await defaultFamilyOperationsAdapter.resolveCalendarConflict(
      "link/1",
      "keep_eliza",
      "2026-08-30T12:00:00.000Z",
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/lifeops/calendar/links/link%2F1/resolve");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      strategy: "keep_eliza",
      expectedUpdatedAt: "2026-08-30T12:00:00.000Z",
    });
  });

  it("retains events and supplies the optimistic-lock timestamp on disconnect", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ outcome: "disconnected" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await defaultFamilyOperationsAdapter.disconnectCalendar(
      "link-1",
      "2026-08-30T13:00:00.000Z",
    );

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      retainEvents: true,
      expectedUpdatedAt: "2026-08-30T13:00:00.000Z",
    });
  });
});
