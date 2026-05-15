export class RollbackQueue {
    tracked = new Map();
    track(phrase) {
        this.tracked.set(phrase.id, { phrase, state: "queued" });
    }
    markSynthesizing(phraseId) {
        const entry = this.requireEntry(phraseId);
        entry.state = "synthesizing";
    }
    markRingBuffered(phraseId) {
        const entry = this.requireEntry(phraseId);
        entry.state = "ringbuffered";
    }
    markPlayed(phraseId) {
        const entry = this.requireEntry(phraseId);
        entry.state = "played";
    }
    drop(phraseId) {
        this.tracked.delete(phraseId);
    }
    onRejected(range) {
        const events = [];
        for (const entry of this.tracked.values()) {
            if (entry.state === "played")
                continue;
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
    snapshot() {
        return Array.from(this.tracked.values()).map((e) => ({ ...e }));
    }
    requireEntry(phraseId) {
        const entry = this.tracked.get(phraseId);
        if (!entry) {
            throw new Error(`RollbackQueue: unknown phraseId ${phraseId}`);
        }
        return entry;
    }
    overlaps(phrase, range) {
        return (phrase.toIndex >= range.fromIndex && phrase.fromIndex <= range.toIndex);
    }
}
//# sourceMappingURL=rollback-queue.js.map