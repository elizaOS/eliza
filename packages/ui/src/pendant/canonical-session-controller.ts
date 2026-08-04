import type {
  PendantSegment,
  PendantSessionSnapshot,
} from "@elizaos/shared/contracts";
import { dispatchPendantVoiceTranscript } from "./pendant-connection";
import type { PendantSessionSyncClient } from "./session-sync-client";
import type { PendantTranscriptSegmentDetail } from "./transcript-segment-event";

export interface CanonicalPendantSessionControllerOptions {
  client: PendantSessionSyncClient;
  holder: string;
  onSnapshot: (snapshot: PendantSessionSnapshot) => void;
  onError: (error: Error) => void;
}

/** Serializes capture mutations and exposes only server-committed snapshots. */
export class CanonicalPendantSessionController {
  private sessionId: string | null = null;
  private leaseToken: string | null = null;
  private nextOrdinal = 0;
  private readonly ordinals = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();
  private generation = 0;

  constructor(
    private readonly options: CanonicalPendantSessionControllerOptions,
  ) {}

  start(): Promise<void> {
    return this.enqueue(async () => {
      if (this.sessionId && this.leaseToken) return;
      const snapshot = await this.options.client.createSession({
        processingLocation: "cloud",
      });
      const lease = await this.options.client.acquireLease(
        snapshot.session.id,
        {
          holder: this.options.holder,
          leaseMs: 5 * 60_000,
        },
      );
      this.sessionId = snapshot.session.id;
      this.leaseToken = lease.leaseToken;
      this.options.onSnapshot(snapshot);
      this.options.client.startPolling(snapshot.session.id);
    });
  }

  handleSegment(detail: PendantTranscriptSegmentDetail): void {
    const generation = this.generation;
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
        dispatchPendantVoiceTranscript(detail.text);
      }
    });
  }

  pause(): void {
    this.generation += 1;
    this.options.client.stopPolling();
    for (const mutation of [...this.options.client.unsyncedQueue]) {
      this.options.client.discardUnsyncedMutation(mutation.id);
    }
    const sessionId = this.sessionId;
    if (!sessionId) return;
    void this.options.client
      .pause(sessionId)
      .catch((error) => this.options.onError(asError(error)));
  }

  resume(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.sessionId) return;
      const snapshot = await this.options.client.resume(this.sessionId);
      this.options.onSnapshot(snapshot);
      this.options.client.startPolling(this.sessionId);
    });
  }

  stop(): void {
    this.generation += 1;
    this.options.client.stopPolling();
  }

  private async ensureStarted(): Promise<void> {
    if (this.sessionId && this.leaseToken) return;
    const snapshot = await this.options.client.createSession({
      processingLocation: "cloud",
    });
    const lease = await this.options.client.acquireLease(snapshot.session.id, {
      holder: this.options.holder,
      leaseMs: 5 * 60_000,
    });
    this.sessionId = snapshot.session.id;
    this.leaseToken = lease.leaseToken;
    this.options.onSnapshot(snapshot);
    this.options.client.startPolling(snapshot.session.id);
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
