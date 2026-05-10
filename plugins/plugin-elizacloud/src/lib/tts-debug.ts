function truthy(raw: string | undefined | null): boolean {
  if (raw == null) return false;
  const value = String(raw).trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function ttsDebugEnabled(): boolean {
  if (typeof process !== "undefined" && process.env) {
    if (truthy(process.env.ELIZA_TTS_DEBUG)) return true;
  }
  return false;
}

export function isTtsDebugEnabled(): boolean {
  return ttsDebugEnabled();
}

export function ttsDebugTextPreview(text: string, maxChars = 160): string {
  const singleLine = text.replace(/\r?\n/g, "↵ ").replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) return singleLine;
  return `${singleLine.slice(0, maxChars)}…`;
}

export function ttsDebug(
  phase: string,
  detail?: Record<string, unknown>,
): void {
  if (!ttsDebugEnabled()) return;
  if (detail && Object.keys(detail).length > 0) {
    console.info(`[eliza][tts] ${phase}`, detail);
  } else {
    console.info(`[eliza][tts] ${phase}`);
  }
}
