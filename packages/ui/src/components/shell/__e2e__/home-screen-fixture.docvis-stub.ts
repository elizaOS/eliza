// Stub the visibility-interval hooks for the e2e (no live timers in headless).
export function useIntervalWhenDocumentVisible() {}
export function useDocumentVisibility() { return true; }
