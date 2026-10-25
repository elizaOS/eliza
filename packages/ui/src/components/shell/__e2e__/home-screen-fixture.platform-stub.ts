// Stubs platform-guards for the home-screen e2e: the fixture always runs as a
// web/GUI surface, so pin the modality + platform instead of probing the (absent)
// native bridge.
export function getActiveViewModality() {
  return "gui";
}

export function getFrontendPlatform() {
  return "web";
}
