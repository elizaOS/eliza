import type { TabCommittedDetail } from "./types";

/**
 * In-process pub/sub for tab navigation commits. Use with
 * `navigation.scheduleAfterTabCommit` from app context to chain shell/tab
 * updates without racing batched `setTab` calls.
 */
export class NavigationEventHub {
  private listeners = new Set<(detail: TabCommittedDetail) => void>();

  subscribe(listener: (detail: TabCommittedDetail) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(detail: TabCommittedDetail): void {
    const slice = [...this.listeners];
    for (const listener of slice) {
      try {
        listener(detail);
      } catch (err) {
        console.warn("[eliza][navigation] tabCommitted listener failed", err);
      }
    }
  }
}
