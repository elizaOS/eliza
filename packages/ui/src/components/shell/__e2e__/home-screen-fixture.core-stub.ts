// Stubs the @elizaos/core view helpers the home-screen e2e bundle reaches:
// every seeded view counts as visible, and dedupeModalities just uniques the
// list. Keeps the browser bundle off the full core graph.
export function isViewVisible() {
  return true;
}

export function dedupeModalities(modalities: string[]) {
  return Array.from(new Set(modalities));
}
