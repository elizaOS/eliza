const STREAM_POPOUT_WINDOW_TARGET = "elizaos-stream";
const STREAM_POPOUT_WINDOW_FEATURES =
  "width=1280,height=720,menubar=no,toolbar=no,location=no,status=no";

export function buildStreamPopoutUrl(apiBase?: string): string {
  const base = window.location.origin || "";
  const sep =
    window.location.protocol === "file:" ||
    window.location.protocol === "electrobun:"
      ? "#"
      : "";
  const trimmedApiBase = apiBase?.trim();
  const qs = trimmedApiBase
    ? `popout&apiBase=${encodeURIComponent(trimmedApiBase)}`
    : "popout";
  return `${base}${sep}/?${qs}`;
}

export function openStreamPopout(apiBase?: string): Window | null {
  return window.open(
    buildStreamPopoutUrl(apiBase),
    STREAM_POPOUT_WINDOW_TARGET,
    STREAM_POPOUT_WINDOW_FEATURES,
  );
}
