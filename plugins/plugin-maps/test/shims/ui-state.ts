/** Minimal deterministic app-state selector used only by Maps component tests. */

export const mapsTestActionNotices: unknown[][] = [];

export function resetMapsTestActionNotices(): void {
  mapsTestActionNotices.length = 0;
}

const state = {
  setActionNotice: (...args: unknown[]) => mapsTestActionNotices.push(args),
};

export function useAppSelector<T>(selector: (value: typeof state) => T): T {
  return selector(state);
}
