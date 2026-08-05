import type {
  PendantSegment,
  PendantSessionSnapshot,
} from "@elizaos/shared/contracts";
import { dispatchPendantVoiceTranscript } from "./pendant-connection";
import type { PendantSessionSyncClient } from "./session-sync-client";
import type { PendantTranscriptSegmentDetail } from "./transcript-segment-event";

const DEFAULT_LEASE_MS = 60_000;
const LEASE_RENEWAL_LEAD_MS = 15_000;

export interface CanonicalPendantSessionControllerOptions {
  client: PendantSessionSyncClient;
  holder: string;
  onSnapshot: (snapshot: PendantSessionSnapshot) => void;
  onError: (error: Error) => void;
  leaseMs?: number;
}

/** Serializes capture mutations and exposes only server-committed snapshots. */
export class CanonicalPendantSessionController {
  private sessionId: string | null = null;
  private leaseToken: string | null = null;
  private nextOrdinal = 0;
  private readonly ordinals = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();
  private generation = 0;
  private acceptingSnapshots = false;
  private leaseExpiresAtMs = 0;
  private leaseRenewTimer: ReturnType<typeof setTimeout> | null = null;
  private ownsSessionLifecycle = false;

  constructor(
    private readonly options: CanonicalPendantSessionControllerOptions,
  ) {}

  start(): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureStarted();
    });
  }

  followLatest(): Promise<PendantSessionSnapshot | null> {
    let discovered: PendantSessionSnapshot | null = null;
    return this.enqueue(async () => {
      if (this.sessionId) {
        discovered = this.options.client.currentSnapshot;
        return;
      }
      discovered = await this.options.client.discoverCurrentSession();
      if (!discovered) return;
      this.adoptSnapshot(discovered, false);
    }).then(() => discovered);
  }

  handleSegment(detail: PendantTranscriptSegmentDetail): void {
    const generation = this.generation;
    // error-policy:J5 enqueue observes and reports this same rejection through onError.
    void this.enqueue(async () => {
      if (generation !== this.generation || detail.status === "discarded")
        return;
      await this.ensureStarted();
      if (generation !== this.generation) return;
      const sessionId = this.sessionId;
      const leaseToken = this.leaseToken;
      if (!sessionId || !leaseToken)
        throw new Error("Pendant session is unavailable");

      let ordinal = this.ordinals.get(detail.id);
      if (ordinal === undefined) {
        ordinal = this.nextOrdinal++;
        this.ordinals.set(detail.id, ordinal);
        const pending = await this.options.client.appendSegment(sessionId, {
          leaseToken,
          segment: toWireSegment(detail, ordinal, "pending", 0),
        });
        if (generation !== this.generation) return;
        this.options.onSnapshot(pending);
      }
      if (detail.status === "pending") return;
      if (generation !== this.generation) return;

      const committed = await this.options.client.patchSegment(
        sessionId,
        `${sessionId}:segment:${ordinal}`,
        {
          leaseToken,
          revision: 1,
          status: detail.status === "resolved" ? "resolved" : "asr-error",
          text: detail.text?.trim() ?? "",
          words: (detail.words ?? []).map((word) => ({
            word: word.text,
            startMs: word.startMs,
            endMs: word.endMs,
          })),
          error:
            detail.status === "failed"
              ? (detail.warning ?? "ASR failed")
              : null,
          endedAt: new Date(detail.endedAt).toISOString(),
        },
      );
      if (generation !== this.generation) return;
      this.options.onSnapshot(committed);
      if (detail.status === "resolved" && detail.text?.trim()) {
        dispatchPendantVoiceTranscript(detail.text, {
          ownerId: committed.session.ownerId,
          agentId: committed.session.agentId,
          sessionId: committed.session.id,
          segmentId: `${committed.session.id}:segment:${ordinal}`,
          segmentRevision: 1,
        });
      }
    }).catch(() => undefined);
  }

  pause(): Promise<void> {
    this.severCaptureGeneration();
    return this.enqueue(async () => {
      if (!this.sessionId) return;
      await this.options.client.pause(this.sessionId);
    });
  }

  resume(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.sessionId) return;
      if (!this.leaseToken) await this.acquireOrRenewLease();
      const snapshot = await this.options.client.resume(this.sessionId);
      this.acceptingSnapshots = true;
      this.options.onSnapshot(snapshot);
      this.options.client.startPolling(this.sessionId);
      this.scheduleLeaseRenewal();
    });
  }

  stop(): Promise<void> {
    this.severCaptureGeneration();
    this.clearLeaseRenewal();
    return this.enqueue(async () => {
      const sessionId = this.sessionId;
      const shouldEndSession = this.ownsSessionLifecycle;
      try {
        if (sessionId && shouldEndSession) {
          await this.options.client.end(sessionId);
        }
      } finally {
        this.sessionId = null;
        this.leaseToken = null;
        this.leaseExpiresAtMs = 0;
        this.ownsSessionLifecycle = false;
        this.nextOrdinal = 0;
        this.ordinals.clear();
      }
    });
  }

  acceptsSnapshot(snapshot: PendantSessionSnapshot): boolean {
    return this.acceptingSnapshots && this.sessionId === snapshot.session.id;
  }

  private async ensureStarted(): Promise<void> {
    if (!this.sessionId) {
      const discovered = await this.options.client.discoverCurrentSession();
      const snapshot =
        discovered ??
        (await this.options.client.createSession({
          processingLocation: "cloud",
        }));
      this.adoptSnapshot(snapshot, discovered === null);
    }
    if (!this.leaseToken) await this.acquireOrRenewLease();
    if (!this.sessionId) throw new Error("Pendant session is unavailable");
    const current = this.options.client.currentSnapshot;
    if (current?.session.state === "paused") {
      const resumed = await this.options.client.resume(this.sessionId);
      this.options.onSnapshot(resumed);
    }
    this.acceptingSnapshots = true;
    this.options.client.startPolling(this.sessionId);
    this.scheduleLeaseRenewal();
  }

  private adoptSnapshot(
    snapshot: PendantSessionSnapshot,
    ownsSessionLifecycle: boolean,
  ): void {
    this.sessionId = snapshot.session.id;
    this.ownsSessionLifecycle = ownsSessionLifecycle;
    this.nextOrdinal = snapshot.segments.length;
    this.ordinals.clear();
    this.acceptingSnapshots = snapshot.session.state !== "ended";
    this.options.onSnapshot(snapshot);
    if (this.acceptingSnapshots) {
      this.options.client.startPolling(snapshot.session.id);
    }
  }

  private async acquireOrRenewLease(): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) throw new Error("Pendant session is unavailable");
    const lease = await this.options.client.acquireLease(sessionId, {
      holder: this.options.holder,
      ...(this.leaseToken ? { leaseToken: this.leaseToken } : {}),
      leaseMs: this.options.leaseMs ?? DEFAULT_LEASE_MS,
    });
    this.leaseToken = lease.leaseToken;
    this.ownsSessionLifecycle = true;
    this.leaseExpiresAtMs = Date.parse(
      lease.session.captureLease?.expiresAt ?? "",
    );
    if (!Number.isFinite(this.leaseExpiresAtMs)) {
      this.leaseExpiresAtMs =
        Date.now() + (this.options.leaseMs ?? DEFAULT_LEASE_MS);
    }
  }

  private scheduleLeaseRenewal(): void {
    this.clearLeaseRenewal();
    if (!this.sessionId || !this.leaseToken) return;
    const delay = Math.max(
      1_000,
      this.leaseExpiresAtMs - Date.now() - LEASE_RENEWAL_LEAD_MS,
    );
    this.leaseRenewTimer = setTimeout(() => {
      this.leaseRenewTimer = null;
      // error-policy:J5 enqueue observes and reports this same rejection through onError.
      void this.enqueue(async () => {
        if (!this.sessionId || !this.leaseToken) return;
        await this.acquireOrRenewLease();
        this.scheduleLeaseRenewal();
      }).catch(() => undefined);
    }, delay);
    (
      this.leaseRenewTimer as ReturnType<typeof setTimeout> & {
        unref?: () => void;
      }
    ).unref?.();
  }

  private clearLeaseRenewal(): void {
    if (this.leaseRenewTimer) clearTimeout(this.leaseRenewTimer);
    this.leaseRenewTimer = null;
  }

  private severCaptureGeneration(): void {
    this.generation += 1;
    this.options.client.stopPolling();
    for (const mutation of [...this.options.client.unsyncedQueue]) {
      this.options.client.discardUnsyncedMutation(mutation.id);
    }
    this.acceptingSnapshots = false;
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.chain.then(work);
    this.chain = result.catch((error) => {
      this.options.onError(asError(error));
    });
    return result;
  }
}

function toWireSegment(
  detail: PendantTranscriptSegmentDetail,
  ordinal: number,
  status: PendantSegment["status"],
  revision: number,
): Omit<PendantSegment, "id" | "sessionId" | "createdAt" | "updatedAt"> {
  return {
    ordinal,
    status,
    text: status === "resolved" ? (detail.text?.trim() ?? "") : "",
    words: (detail.words ?? []).map((word) => ({
      word: word.text,
      startMs: word.startMs,
      endMs: word.endMs,
    })),
    speakerCluster: null,
    speakerAlias: null,
    confidence: null,
    error: null,
    startedAt: new Date(detail.startedAt).toISOString(),
    endedAt:
      status === "pending" ? null : new Date(detail.endedAt).toISOString(),
    revision,
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
