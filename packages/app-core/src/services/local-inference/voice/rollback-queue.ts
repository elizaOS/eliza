import type { Phrase, RejectedTokenRange } from "./types";

type PhraseState = "queued" | "synthesizing" | "ringbuffered" | "played";

interface TrackedPhrase {
  phrase: Phrase;
  state: PhraseState;
}

export interface RollbackEvent {
  phraseId: number;
  reason: "rejected-tokens";
  rejectedRange: RejectedTokenRange;
}

export class RollbackQueue {
  private readonly tracked = new Map<number, TrackedPhrase>();

  track(phrase: Phrase): void {
    this.tracked.set(phrase.id, { phrase, state: "queued" });
  }

  markSynthesizing(phraseId: number): void {
    const entry = this.requireEntry(phraseId);
    entry.state = "synthesizing";
  }

  markRingBuffered(phraseId: number): void {
    const entry = this.requireEntry(phraseId);
    entry.state = "ringbuffered";
  }

  markPlayed(phraseId: number): void {
    const entry = this.requireEntry(phraseId);
    entry.state = "played";
  }

  drop(phraseId: number): void {
    this.tracked.delete(phraseId);
  }

  onRejected(range: RejectedTokenRange): RollbackEvent[] {
    const events: RollbackEvent[] = [];
    for (const entry of this.tracked.values()) {
      if (entry.state === "played") continue;
      if (this.overlaps(entry.phrase, range)) {
        events.push({
          phraseId: entry.phrase.id,
          reason: "rejected-tokens",
          rejectedRange: range,
        });
      }
    }
    return events;
  }

  snapshot(): ReadonlyArray<{ phrase: Phrase; state: PhraseState }> {
    return Array.from(this.tracked.values()).map((e) => ({ ...e }));
  }

  private requireEntry(phraseId: number): TrackedPhrase {
    const entry = this.tracked.get(phraseId);
    if (!entry) {
      throw new Error(`RollbackQueue: unknown phraseId ${phraseId}`);
    }
    return entry;
  }

  private overlaps(phrase: Phrase, range: RejectedTokenRange): boolean {
    return phrase.toIndex >= range.fromIndex && phrase.fromIndex <= range.toIndex;
  }
}
