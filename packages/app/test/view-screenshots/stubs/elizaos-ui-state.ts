/**
 * Stub for `@elizaos/ui/state` — the app-state store hook surface. The only
 * selector the harness views reach for is `setActionNotice` (CalendarView /
 * CalendarSection); the harness never asserts on notices, so it is a no-op.
 */

interface HarnessAppState {
  setActionNotice: (...args: unknown[]) => void;
}

const HARNESS_STATE: HarnessAppState = {
  setActionNotice: () => {},
};

export function useAppSelector<T>(selector: (state: HarnessAppState) => T): T {
  return selector(HARNESS_STATE);
}
