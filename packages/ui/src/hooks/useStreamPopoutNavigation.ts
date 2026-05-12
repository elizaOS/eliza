export function getNextTabForStreamPopoutEvent<TTab extends string>(
  _detail: unknown,
): TTab | null {
  return null;
}

export function useStreamPopoutNavigation<TTab extends string>(
  _setTab: (tab: TTab) => void,
): void {}
