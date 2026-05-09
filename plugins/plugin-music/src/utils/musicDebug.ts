import { logger } from "@elizaos/core";

/** Set `ELIZA_MUSIC_DEBUG=1` for verbose music-player / cache / stream logs. */
export function isMusicDebugEnabled(): boolean {
  const v = process.env.ELIZA_MUSIC_DEBUG?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Max chars for stderr/stdout embedded in debug JSON (avoid huge log lines). */
const MUSIC_DEBUG_MAX_CLI_CHARS = 16_384;

function truncateCliText(s: string): string {
  const t = s.trimEnd();
  if (t.length <= MUSIC_DEBUG_MAX_CLI_CHARS) {
    return t;
  }
  return `${t.slice(0, MUSIC_DEBUG_MAX_CLI_CHARS)}…[truncated ${t.length - MUSIC_DEBUG_MAX_CLI_CHARS} chars]`;
}

function sanitizeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...meta };
  for (const key of ["stderr", "stdout"] as const) {
    const v = out[key];
    if (typeof v === "string" && v.length > 0) {
      out[key] = truncateCliText(v);
    }
  }
  for (const key of ["command", "cmdline"] as const) {
    const v = out[key];
    if (typeof v === "string" && v.length > MUSIC_DEBUG_MAX_CLI_CHARS) {
      out[key] = truncateCliText(v);
    }
  }
  return out;
}

/** Pretty-print argv for debug logs (quote args that need it). */
export function formatMusicDebugCommand(
  bin: string,
  args: readonly string[],
): string {
  return [
    bin,
    ...args.map((a) => (/[\s"'\\]/.test(a) ? JSON.stringify(a) : a)),
  ].join(" ");
}

export function musicDebug(
  message: string,
  meta?: Record<string, unknown>,
): void {
  if (!isMusicDebugEnabled()) {
    return;
  }
  if (meta && Object.keys(meta).length > 0) {
    logger.debug(
      `[eliza][music] ${message} ${JSON.stringify(sanitizeMeta(meta))}`,
    );
  } else {
    logger.debug(`[eliza][music] ${message}`);
  }
}
