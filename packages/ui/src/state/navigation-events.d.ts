import type { TabCommittedDetail } from "./types";
/**
 * In-process pub/sub for tab navigation commits. Use with
 * `navigation.scheduleAfterTabCommit` from app context to chain shell/tab
 * updates without racing batched `setTab` calls.
 */
export declare class NavigationEventHub {
  private listeners;
  subscribe(listener: (detail: TabCommittedDetail) => void): () => void;
  emit(detail: TabCommittedDetail): void;
}
//# sourceMappingURL=navigation-events.d.ts.map
