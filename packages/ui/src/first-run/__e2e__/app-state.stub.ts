// Browser-pure stand-in for the `../state` barrel in the in-chat first-run e2e
// bundle (#9952). FirstRunChat only reads `setTab` (to route the "other"
// provider to Settings); the real barrel pulls the entire app store + context
// graph. The stub records the routed tab so the runner can assert the handoff.
declare global {
  interface Window {
    __firstRunRoutedTab?: string;
  }
}

export function useAppSelectorShallow<T>(
  selector: (s: { setTab: (tab: string) => void }) => T,
): T {
  return selector({
    setTab: (tab: string) => {
      if (typeof window !== "undefined") window.__firstRunRoutedTab = tab;
      console.log(`[first-run] setTab(${tab})`);
    },
  });
}
