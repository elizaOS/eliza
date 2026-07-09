/**
 * Unit tests for the pendant session sync browser adapter.
 *
 * The server route owns persistence; this file checks client-side queueing and
 * cursor convergence around fetch failures and replay.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithCsrfMock = vi.hoisted(() => vi.fn());

vi.mock("../api/csrf-client", () => ({
  fetchWithCsrf: fetchWithCsrfMock,
}));

vi.mock("../utils/asset-url", () => ({
  resolveApiUrl: (url: string) => url,
}));

vi.mock("@elizaos/shared/contracts", () => ({
  PENDANT_SESSION_SYNC_API_PREFIX: "/api/pendant/sessions",
}));

const { PendantSessionSyncClient } = await import("./session-sync-client");

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function snapshot(revision: number, sessionId = "sess-a") {
  return {
    schemaVersion: 1,
    session: {
      id: sessionId,
      ownerId: "owner",
      agentId: "agent",
      startedAt: "2026-07-09T00:00:00.000Z",
      endedAt: null,
      state: "active",
      captureLease: null,
      processingLocation: "on-device",
      revision,
    },
    segments: [],
    insightRefs: [],
  };
}

describe("PendantSessionSyncClient", () => {
  beforeEach(() => {
    fetchWithCsrfMock.mockReset();
  });

  it("queues offline appends and drains them before polling", async () => {
    const fetcher = fetchWithCsrfMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(response({ ok: true, snapshot: snapshot(1) }))
      .mockResolvedValueOnce(response({ ok: true, changed: false }));
    const seen: number[] = [];
    const client = new PendantSessionSyncClient({
      fetcher,
      onSnapshot: (next) => seen.push(next.session.revision),
    });
    Object.defineProperty(client, "snapshot", {
      value: snapshot(0),
      writable: true,
    });

    const local = await client.appendSegment("sess-a", {
      leaseToken: "lease",
      segment: {
        ordinal: 0,
        status: "resolved",
        text: "hello",
        words: [],
        speakerCluster: null,
        speakerAlias: null,
        confidence: null,
        error: null,
        startedAt: "2026-07-09T00:00:00.000Z",
        endedAt: null,
        revision: 0,
      },
    });

    expect(local.session.revision).toBe(0);
    expect(client.unsyncedQueue).toHaveLength(1);
    await client.flushQueue();
    expect(client.unsyncedQueue).toHaveLength(0);
    await client.poll("sess-a");
    expect(seen).toEqual([1]);
    expect(fetcher.mock.calls.at(-1)?.[0]).toContain("afterRevision=1");
  });

  it("surfaces offline revision conflicts and converges after explicit discard", async () => {
    const fetcher = fetchWithCsrfMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(
        response(
          {
            ok: false,
            error: {
              code: "revision_conflict",
              message: "stale segment",
              currentRevision: 3,
            },
          },
          409,
        ),
      )
      .mockResolvedValueOnce(
        response({ ok: true, changed: true, snapshot: snapshot(3) }),
      );
    const client = new PendantSessionSyncClient({ fetcher });
    Object.defineProperty(client, "snapshot", {
      value: snapshot(0),
      writable: true,
    });

    await client.appendSegment("sess-a", {
      leaseToken: "lease",
      segment: {
        ordinal: 0,
        status: "resolved",
        text: "hello",
        words: [],
        speakerCluster: null,
        speakerAlias: null,
        confidence: null,
        error: null,
        startedAt: "2026-07-09T00:00:00.000Z",
        endedAt: null,
        revision: 0,
      },
    });
    await expect(client.flushQueue()).rejects.toMatchObject({
      response: { error: { code: "revision_conflict" } },
    });
    expect(client.unsyncedQueue[0]?.status).toBe("conflict");
    expect(client.discardUnsyncedMutation("append:sess-a:0")).toBe(true);
    await client.poll("sess-a");
    expect(client.currentSnapshot?.session.revision).toBe(3);
  });

  it("does not reuse a revision cursor when switching sessions", async () => {
    const fetcher = fetchWithCsrfMock.mockResolvedValueOnce(
      response({
        ok: true,
        changed: true,
        snapshot: snapshot(0, "sess-b"),
      }),
    );
    const client = new PendantSessionSyncClient({ fetcher });
    Object.defineProperty(client, "snapshot", {
      value: snapshot(5, "sess-a"),
      writable: true,
    });

    await client.poll("sess-b");
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/pendant/sessions/sess-b");
    expect(client.currentSnapshot?.session.id).toBe("sess-b");
  });

  it("ignores stale snapshots during convergence", async () => {
    const client = new PendantSessionSyncClient();
    Object.defineProperty(client, "snapshot", {
      value: snapshot(5),
      writable: true,
    });
    (
      client as unknown as { acceptSnapshot: (value: unknown) => void }
    ).acceptSnapshot(snapshot(3));
    expect(client.currentSnapshot?.session.revision).toBe(5);
  });

  it("does not reschedule an in-flight poll after stop", async () => {
    vi.useFakeTimers();
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const client = new PendantSessionSyncClient({ fetcher, pollMs: 500 });

    try {
      client.startPolling("sess-a");
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(1);
      client.stopPolling();
      resolveFetch?.(response({ ok: true, changed: false }));
      await Promise.resolve();
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      client.stopPolling();
      vi.useRealTimers();
    }
  });
});
