export function isViewVisible() {
  return true;
}

export function dedupeModalities(modalities: string[]) {
  return Array.from(new Set(modalities));
}
