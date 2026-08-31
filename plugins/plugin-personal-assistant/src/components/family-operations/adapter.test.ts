/** HTTP contract tests for Family Operations calendar conflict mutations. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultFamilyOperationsAdapter } from "./adapter.js";

afterEach(() => vi.unstubAllGlobals());

describe("defaultFamilyOperationsAdapter", () => {
  it("loads and mutates the mounted family workflow contracts", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      calls.push(path);
      const payload = path.endsWith("/agreements")
        ? { agreements: [] }
        : path.endsWith("/calendar/links")
          ? { links: [] }
          : path.endsWith("/school/status")
            ? { sourceId: "concord", config: null, lastRun: null }
            : path.endsWith("/packets")
              ? { packets: [] }
              : {};
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await defaultFamilyOperationsAdapter.load();
    expect(snapshot.school).toMatchObject({
      status: "ready",
      data: { state: "never_run" },
    });
    expect(snapshot.packets).toEqual({ status: "ready", data: [] });

    await defaultFamilyOperationsAdapter.runSchoolWorkflow();
    await defaultFamilyOperationsAdapter.approveSchoolDiff("run/1");
    await defaultFamilyOperationsAdapter.generatePacket("2026-08");

    expect(calls).toContain(
      "/api/lifeops/family-workflows/school/status",
    );
    expect(calls).toContain("/api/lifeops/family-workflows/school/run");
    expect(calls).toContain("/api/lifeops/family-workflows/school/apply");
    expect(
      calls.filter(
        (path) => path === "/api/lifeops/family-workflows/packets",
      ),
    ).toHaveLength(2);
  });

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
