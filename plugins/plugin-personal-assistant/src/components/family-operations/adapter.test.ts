/** HTTP contract tests for Family Operations calendar conflict mutations. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultFamilyOperationsAdapter } from "./adapter.js";

afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

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
        const path = String(input);
        const payload =
          path === "/api/lifeops/agreement-uploads"
            ? {
                upload: {
                  uploadId: "upload-1",
                  sizeBytes: 8,
                  chunkSizeBytes: 4,
                  chunkCount: 2,
                  receivedChunks: [],
                  receivedBytes: 0,
                  status: "uploading",
                },
              }
            : { upload: {} };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const file = new File(["%PDF-1.7"], "agreement.pdf", {
      type: "application/pdf",
      lastModified: 1,
    });

    await defaultFamilyOperationsAdapter.uploadAgreement({
      agreementKey: "parenting-plan",
      title: "Parenting agreement",
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
      "/api/lifeops/agreement-uploads",
      "/api/lifeops/agreement-uploads/upload-1/chunks/0",
      "/api/lifeops/agreement-uploads/upload-1/chunks/1",
      "/api/lifeops/agreement-uploads/upload-1/commit",
      "/api/lifeops/family-workflows/packets/packet%2F1/drafts",
      "/api/lifeops/family-workflows/packets/packet%2F1/drafts/3/approval",
    ]);
    expect(JSON.parse(calls[0]?.[1]?.body as string)).toMatchObject({
      originalFilename: "agreement.pdf",
      mimeType: "application/pdf",
      sizeBytes: 8,
    });
    expect(calls[1]?.[1]?.body).toBeInstanceOf(ArrayBuffer);
    expect(calls[2]?.[1]?.body).toBeInstanceOf(ArrayBuffer);
    expect(JSON.parse(calls[3]?.[1]?.body as string)).toEqual({
      contentIdentity: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.parse(calls[4]?.[1]?.body as string)).toEqual({
      recipient: "+15551234567",
      recipientEntityId: "guest-1",
      calendarPrivacyMode: "times_only",
    });
  });

  it("uploads a PDF above the former 20 MiB ceiling in bounded chunks", async () => {
    const size = 20 * 1024 * 1024 + 1;
    const chunkSizeBytes = 4 * 1024 * 1024;
    const chunkCount = Math.ceil(size / chunkSizeBytes);
    const fetchMock = vi.fn(async (_input: string | URL | Request) => {
      return new Response(
        JSON.stringify({
          upload: {
            uploadId: "large-upload",
            sizeBytes: size,
            chunkSizeBytes,
            chunkCount,
            receivedChunks: [],
            receivedBytes: 0,
            status: "uploading",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const file = {
      name: "oversized.pdf",
      type: "application/pdf",
      size,
      lastModified: 1,
      slice: (start: number, end: number) => ({
        arrayBuffer: async () => {
          const bytes = new Uint8Array(end - start);
          if (start === 0) bytes.set(new TextEncoder().encode("%PDF-"));
          return bytes.buffer;
        },
      }),
    } as unknown as File;

    await defaultFamilyOperationsAdapter.uploadAgreement({
      agreementKey: "parenting-plan",
      title: "Parenting agreement",
      file,
    });
    expect(
      fetchMock.mock.calls.filter(([path]) =>
        String(path).includes("/chunks/"),
      ),
    ).toHaveLength(chunkCount);
  });

  it("rehashes skipped chunks and rejects a stale resumable upload", async () => {
    const staleBytes = new TextEncoder().encode("old!").buffer;
    const staleHash = await crypto.subtle.digest("SHA-256", staleBytes);
    const staleHashHex = [...new Uint8Array(staleHash)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const file = new File(["%PDF-new"], "agreement.pdf", {
      type: "application/pdf",
      lastModified: 1,
    });
    const resumeKey = `lifeops:agreement-upload:${file.name}:${file.size}:${file.lastModified}:parenting-plan:Parenting agreement`;
    sessionStorage.setItem(resumeKey, "stale-upload");
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            upload: {
              uploadId: "stale-upload",
              sizeBytes: file.size,
              chunkSizeBytes: 4,
              chunkCount: Math.ceil(file.size / 4),
              receivedChunks: [{ index: 0, size: 4, sha256: staleHashHex }],
              receivedBytes: 4,
              status: "uploading",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      defaultFamilyOperationsAdapter.uploadAgreement({
        agreementKey: "parenting-plan",
        title: "Parenting agreement",
        file,
      }),
    ).rejects.toThrow("no longer matches the resumable upload");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(resumeKey)).toBeNull();
  });

  it("rehashes a matching resumed chunk and commits the complete content identity", async () => {
    const file = new File(["%PDF-1.7"], "agreement.pdf", {
      type: "application/pdf",
      lastModified: 1,
    });
    const first = await file.slice(0, 4).arrayBuffer();
    const firstDigest = await crypto.subtle.digest("SHA-256", first);
    const firstSha256 = [...new Uint8Array(firstDigest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const resumeKey = `lifeops:agreement-upload:${file.name}:${file.size}:${file.lastModified}:parenting-plan:Parenting agreement`;
    sessionStorage.setItem(resumeKey, "upload-1");
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = String(input);
        calls.push([path, init]);
        const payload =
          path === "/api/lifeops/agreement-uploads/upload-1"
            ? {
                upload: {
                  uploadId: "upload-1",
                  sizeBytes: file.size,
                  chunkSizeBytes: 4,
                  chunkCount: 2,
                  receivedChunks: [{ index: 0, size: 4, sha256: firstSha256 }],
                  receivedBytes: 4,
                  status: "uploading",
                },
              }
            : { upload: {} };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    await defaultFamilyOperationsAdapter.uploadAgreement({
      agreementKey: "parenting-plan",
      title: "Parenting agreement",
      file,
    });

    expect(calls.map(([path]) => path)).toEqual([
      "/api/lifeops/agreement-uploads/upload-1",
      "/api/lifeops/agreement-uploads/upload-1/chunks/1",
      "/api/lifeops/agreement-uploads/upload-1/commit",
    ]);
    expect(JSON.parse(calls[2]?.[1]?.body as string)).toEqual({
      contentIdentity: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(sessionStorage.getItem(resumeKey)).toBeNull();
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
