// Stubs useViewKinds for the home-screen e2e: enable developer + preview kinds
// so the launcher curation exercises the full view set without the live
// preferences store.
export function useEnabledViewKinds() {
  return { developer: true, preview: true };
}
