/**
 * Browser client for the server-authoritative pendant session primitive.
 *
 * The adapter keeps local capture code simple: mutations are sent through the
 * authenticated API, failed writes remain in an explicit FIFO queue, and polling
 * converges on the server revision rather than trusting local transcript state.
 */

import type {
  AcquirePendantLeaseRequest,
  PatchPendantSegmentRequest,
  PendantDeleteResponse,
  PendantExportResponse,
  PendantLeaseResponse,
  PendantMutationResponse,
  PendantSessionErrorResponse,
  PendantSessionSnapshot,
  PollPendantSessionResponse,
  UpsertPendantInsightRefsRequest,
  UpsertPendantSegmentRequest,
} from "@elizaos/shared/contracts";
import { PENDANT_SESSION_SYNC_API_PREFIX } from "@elizaos/shared/contracts";
import { fetchWithCsrf } from "../api/csrf-client";
import { resolveApiUrl } from "../utils/asset-url";

type Fetcher = typeof fetchWithCsrf;

export interface PendantSessionSyncClientOptions {
  fetcher?: Fetcher;
  pollMs?: number;
  onSnapshot?: (snapshot: PendantSessionSnapshot) => void;
  onError?: (error: Error) => void;
}

export interface QueuedPendantMutation {
  id: string;
  status: "pending" | "conflict";
  error?: PendantSessionSyncError;
  run: () => Promise<PendantSessionSnapshot>;
}

export class PendantSessionSyncError extends Error {
  constructor(
    message: string,
    readonly response?: PendantSessionErrorResponse,
  ) {
    super(message);
  }
}

export class PendantSessionSyncClient {
  private readonly fetcher: Fetcher;
  private readonly pollMs: number;
  private readonly onSnapshot?: (snapshot: PendantSessionSnapshot) => void;
  private readonly onError?: (error: Error) => void;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollingGeneration = 0;
  private draining = false;
  private snapshot: PendantSessionSnapshot | null = null;
  readonly unsyncedQueue: QueuedPendantMutation[] = [];

  constructor(options: PendantSessionSyncClientOptions = {}) {
    this.fetcher = options.fetcher ?? fetchWithCsrf;
    this.pollMs = options.pollMs ?? 500;
    this.onSnapshot = options.onSnapshot;
    this.onError = options.onError;
  }

  get currentSnapshot(): PendantSessionSnapshot | null {
    return this.snapshot;
  }

  startPolling(sessionId: string): void {
    this.stopPolling();
    const generation = this.pollingGeneration;
    const tick = async (): Promise<void> => {
      try {
        await this.flushQueue();
      } catch (err) {
        if (generation === this.pollingGeneration) {
          this.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      }
      try {
        await this.poll(sessionId);
      } catch (err) {
        if (generation === this.pollingGeneration) {
          this.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        if (generation === this.pollingGeneration) {
          this.pollTimer = setTimeout(tick, this.pollMs);
        }
      }
    };
    this.pollTimer = setTimeout(tick, 0);
  }

  stopPolling(): void {
    this.pollingGeneration += 1;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  async createSession(
    input: {
      sessionId?: string;
      processingLocation?: "on-device" | "cloud";
    } = {},
  ): Promise<PendantSessionSnapshot> {
    return this.requestSnapshot(PENDANT_SESSION_SYNC_API_PREFIX, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async acquireLease(
    sessionId: string,
    request: AcquirePendantLeaseRequest,
  ): Promise<PendantLeaseResponse> {
    return this.request<PendantLeaseResponse>(`${path(sessionId)}/lease`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async appendSegment(
    sessionId: string,
    request: UpsertPendantSegmentRequest,
  ): Promise<PendantSessionSnapshot> {
    return this.enqueueOrRun(
      `append:${sessionId}:${request.segment.ordinal}`,
      () =>
        this.requestMutation(`${path(sessionId)}/segments`, {
          method: "POST",
          body: JSON.stringify(request),
        }),
    );
  }

  async patchSegment(
    sessionId: string,
    segmentId: string,
    request: PatchPendantSegmentRequest,
  ): Promise<PendantSessionSnapshot> {
    return this.enqueueOrRun(
      `patch:${sessionId}:${segmentId}:${request.revision}`,
      () =>
        this.requestMutation(
          `${path(sessionId)}/segments/${encodeURIComponent(segmentId)}`,
          {
            method: "PATCH",
            body: JSON.stringify(request),
          },
        ),
    );
  }

  async pause(
    sessionId: string,
    revision?: number,
  ): Promise<PendantSessionSnapshot> {
    return this.requestMutation(`${path(sessionId)}/pause`, {
      method: "POST",
      body: JSON.stringify({ revision }),
    });
  }

  async resume(
    sessionId: string,
    revision?: number,
  ): Promise<PendantSessionSnapshot> {
    return this.requestMutation(`${path(sessionId)}/resume`, {
      method: "POST",
      body: JSON.stringify({ revision }),
    });
  }

  async end(
    sessionId: string,
    revision?: number,
  ): Promise<PendantSessionSnapshot> {
    return this.requestMutation(`${path(sessionId)}/end`, {
      method: "POST",
      body: JSON.stringify({ revision }),
    });
  }

  async upsertInsightRefs(
    sessionId: string,
    request: UpsertPendantInsightRefsRequest,
  ): Promise<PendantSessionSnapshot> {
    return this.requestMutation(`${path(sessionId)}/insight-refs`, {
      method: "PUT",
      body: JSON.stringify(request),
    });
  }

  async poll(sessionId: string): Promise<PendantSessionSnapshot | null> {
    const afterRevision =
      this.snapshot?.session.id === sessionId
        ? this.snapshot.session.revision
        : undefined;
    const suffix =
      afterRevision === undefined ? "" : `?afterRevision=${afterRevision}`;
    const response = await this.request<PollPendantSessionResponse>(
      `${path(sessionId)}${suffix}`,
      { method: "GET" },
    );
    if (!response.changed) return null;
    this.acceptSnapshot(response.snapshot);
    return response.snapshot;
  }

  async exportSession(sessionId: string): Promise<PendantSessionSnapshot> {
    const response = await this.request<PendantExportResponse>(
      `${path(sessionId)}/export`,
      { method: "GET" },
    );
    return response.export;
  }

  async deleteSession(sessionId: string): Promise<PendantDeleteResponse> {
    const response = await this.request<PendantDeleteResponse>(
      path(sessionId),
      {
        method: "DELETE",
      },
    );
    if (this.snapshot?.session.id === sessionId) this.snapshot = null;
    return response;
  }

  async flushQueue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.unsyncedQueue.length > 0) {
        const next = this.unsyncedQueue[0];
        if (!next) return;
        if (next.status === "conflict" && next.error) throw next.error;
        try {
          const snapshot = await next.run();
          this.acceptSnapshot(snapshot);
          this.unsyncedQueue.shift();
        } catch (err) {
          if (
            err instanceof PendantSessionSyncError &&
            err.response?.error.code !== "store_unavailable"
          ) {
            next.status = "conflict";
            next.error = err;
          }
          throw err;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  discardUnsyncedMutation(id: string): boolean {
    const index = this.unsyncedQueue.findIndex(
      (mutation) => mutation.id === id,
    );
    if (index < 0) return false;
    this.unsyncedQueue.splice(index, 1);
    return true;
  }

  private async enqueueOrRun(
    id: string,
    run: () => Promise<PendantSessionSnapshot>,
  ): Promise<PendantSessionSnapshot> {
    try {
      const snapshot = await run();
      this.acceptSnapshot(snapshot);
      return snapshot;
    } catch (err) {
      if (!isOfflineError(err)) throw err;
      this.unsyncedQueue.push({ id, status: "pending", run });
      if (this.snapshot) return this.snapshot;
      throw err;
    }
  }

  private async requestSnapshot(
    url: string,
    init: RequestInit,
  ): Promise<PendantSessionSnapshot> {
    const response = await this.request<PendantMutationResponse>(url, init);
    this.acceptSnapshot(response.snapshot);
    return response.snapshot;
  }

  private async requestMutation(
    url: string,
    init: RequestInit,
  ): Promise<PendantSessionSnapshot> {
    const response = await this.request<PendantMutationResponse>(url, init);
    this.acceptSnapshot(response.snapshot);
    return response.snapshot;
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    const response = await this.fetcher(resolveApiUrl(url), {
      ...init,
      headers: {
        "content-type": "application/json",
        ...init.headers,
      },
    });
    const body = (await response.json()) as T | PendantSessionErrorResponse;
    if (!response.ok) {
      const errorBody = body as PendantSessionErrorResponse;
      throw new PendantSessionSyncError(
        errorBody.error?.message ?? "Pendant session request failed",
        errorBody,
      );
    }
    return body as T;
  }

  private acceptSnapshot(snapshot: PendantSessionSnapshot): void {
    if (
      this.snapshot &&
      this.snapshot.session.id === snapshot.session.id &&
      snapshot.session.revision <= this.snapshot.session.revision
    ) {
      return;
    }
    this.snapshot = snapshot;
    this.onSnapshot?.(snapshot);
  }
}

export function createPendantSessionSyncClient(
  options?: PendantSessionSyncClientOptions,
): PendantSessionSyncClient {
  return new PendantSessionSyncClient(options);
}

function path(sessionId: string): string {
  return `${PENDANT_SESSION_SYNC_API_PREFIX}/${encodeURIComponent(sessionId)}`;
}

function isOfflineError(err: unknown): boolean {
  if (!(err instanceof TypeError || err instanceof Error)) return false;
  return /Failed to fetch|NetworkError|offline|Load failed/i.test(err.message);
}
