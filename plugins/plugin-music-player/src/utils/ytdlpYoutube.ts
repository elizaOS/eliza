/**
 * YouTube-specific yt-dlp options. Centralized so streaming and cache use the same behavior.
 */

/** Max stderr bytes to attach to thrown errors / logs (full context for bot / format failures). */
export const YTDLP_STDERR_SNIPPET_LEN = 4000;

export function isYoutubeStreamUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    return (
      h === "youtube.com" ||
      h === "www.youtube.com" ||
      h === "m.youtube.com" ||
      h === "music.youtube.com" ||
      h === "youtu.be"
    );
  } catch {
    return false;
  }
}

/**
 * Optional `youtube:…` value for `yt-dlp --extractor-args`.
 *
 * **Default (unset / empty):** do not pass `--extractor-args` — yt-dlp uses its own
 * `player_client` defaults (`android_vr,web_safari`, cookies-aware variants, etc.).
 * Overriding with invalid/obsolete clients (e.g. `tv_embedded`) breaks extraction.
 *
 * Set when you need PO tokens or a specific client list, e.g.
 * `YTDLP_YOUTUBE_EXTRACTOR_ARGS=youtube:player_client=ios,web_safari`
 *
 * Use `default` to force passing `youtube:player_client=default` if you ever need that
 * explicitly (rare).
 */
export function getYoutubeExtractorArgsValue(): string | null {
  const custom = process.env.YTDLP_YOUTUBE_EXTRACTOR_ARGS?.trim();
  if (!custom) {
    return null;
  }
  if (custom.toLowerCase() === "default") {
    return "youtube:player_client=default";
  }
  return custom;
}

function shellDoubleQuoteForExec(s: string): string {
  if (!/[\s\\"'$`!]/.test(s)) {
    return s;
  }
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Shell fragment for audio-cache `exec()` commands (after binary path). */
export function getYoutubeExtractorShellFragment(url: string): string {
  if (!isYoutubeStreamUrl(url)) {
    return "";
  }
  const ex = getYoutubeExtractorArgsValue();
  if (!ex) {
    return "";
  }
  return ` --extractor-args ${shellDoubleQuoteForExec(ex)}`;
}

/** Extra hint when stderr shows EJS / n-challenge issues (after js-runtimes fix). */
export function getYtdlpEjsFailureHint(stderr: string): string {
  const s = stderr.toLowerCase();
  if (
    !s.includes("challenge solving") &&
    !s.includes("javascript runtime") &&
    !s.includes("js challenge")
  ) {
    return "";
  }
  return (
    "\n\nYouTube JS challenge (EJS): yt-dlp needs a JavaScript runtime for some formats. " +
    "Eliza adds `--js-runtimes` for Bun or Node when the API process uses them. " +
    "If errors persist, install Deno or set YTDLP_JS_RUNTIMES (see https://github.com/yt-dlp/yt-dlp/wiki/EJS)."
  );
}

/** Whether a failed yt-dlp run is worth retrying with a more permissive `-f` selector. */
export function shouldRetryYtdlpWithPermissiveFormat(
  stderr: string,
  message: string,
): boolean {
  const s = `${stderr}\n${message}`.toLowerCase();
  if (
    s.includes("sign in to confirm") ||
    s.includes("not a bot") ||
    s.includes("private video") ||
    s.includes("video unavailable")
  ) {
    return false;
  }
  return (
    s.includes("requested format is not available") ||
    s.includes("no suitable formats found")
  );
}
