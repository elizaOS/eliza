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
              ? { packets: [], packetStates: [] }
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

    expect(calls).toContain("/api/lifeops/family-workflows/school/status");
    expect(calls).toContain("/api/lifeops/family-workflows/school/run");
    expect(calls).toContain("/api/lifeops/family-workflows/school/apply");
    expect(
      calls.filter((path) => path === "/api/lifeops/family-workflows/packets"),
    ).toHaveLength(2);
  });

  it("uploads PDF bytes and drives immutable draft and approval routes", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push([String(input), init]);
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const file = {
      name: "agreement.pdf",
      type: "application/pdf",
      arrayBuffer: async () => new TextEncoder().encode("%PDF-1.7").buffer,
    } as File;

    await defaultFamilyOperationsAdapter.uploadAgreement({
      agreementKey: "parenting-plan",
      title: "Parenting agreement",
      pageCount: 14,
      file,
    });
    await defaultFamilyOperationsAdapter.createPacketDraft({
      packetId: "packet/1",
      recipient: "+15551234567",
      recipientEntityId: "guest-1",
      calendarPrivacyMode: "times_only",
    });
    await defaultFamilyOperationsAdapter.requestPacketApproval("packet/1", 3);

    expect(calls.map(([path]) => path)).toEqual([
      "/api/lifeops/agreements",
      "/api/lifeops/family-workflows/packets/packet%2F1/drafts",
      "/api/lifeops/family-workflows/packets/packet%2F1/drafts/3/approval",
    ]);
    expect(JSON.parse(calls[0]?.[1]?.body as string)).toMatchObject({
      originalFilename: "agreement.pdf",
      mimeType: "application/pdf",
      pageCount: 14,
      bytesBase64: "JVBERi0xLjc=",
    });
    expect(JSON.parse(calls[1]?.[1]?.body as string)).toEqual({
      recipient: "+15551234567",
      recipientEntityId: "guest-1",
      calendarPrivacyMode: "times_only",
    });
  });

  it("restores the latest draft and approval binding into the packet view", async () => {
    const packet = {
      packetId: "packet-1",
      period: {
        key: "2026-08",
        startsOn: "2026-08-01",
        endsOnExclusive: "2026-09-01",
        timeZone: "America/New_York",
      },
      version: 1,
      createdAt: "2026-08-30T12:00:00.000Z",
      sections: [],
      claims: [],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = String(input);
        const payload = path.endsWith("/agreements")
          ? { agreements: [] }
          : path.endsWith("/calendar/links")
            ? { links: [] }
            : path.endsWith("/school/status")
              ? { sourceId: "concord", config: null, lastRun: null }
              : {
                  packets: [packet],
                  packetStates: [
                    {
                      packetId: "packet-1",
                      draft: {
                        packetId: "packet-1",
                        internalVersion: 1,
                        draftVersion: 2,
                        recipient: "+15551234567",
                        recipientEntityId: "guest-1",
                        calendarPrivacyMode: "busy_only",
                        includedClaimIds: [],
                        body: "Busy",
                        bodySha256: "hash",
                        transformations: [],
                        createdAt: "2026-08-30T12:01:00.000Z",
                      },
                      approvalId: "approval-1",
                    },
                  ],
                };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const loaded = await defaultFamilyOperationsAdapter.load();
    expect(loaded.packets).toMatchObject({
      status: "ready",
      data: [
        {
          packetId: "packet-1",
          draft: {
            draftVersion: 2,
            recipientEntityId: "guest-1",
            approvalId: "approval-1",
          },
        },
      ],
    });
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
