/**
 * True when the user message is only playback transport (pause/skip/stop/resume),
 * not a request to play new audio. Used so PLAY_AUDIO validate returns false and
 * the runtime picks PLAYBACK_OP (op=pause|resume|skip|stop) instead.
 */
export function isPlaybackTransportControlOnlyMessage(text: string): boolean {
  const raw = (text || "").trim().toLowerCase();
  if (!raw) return false;
  if (/https?:\/\//.test(raw)) return false;
  if (/\byoutube\.|youtu\.be|spotify\.|soundcloud\./.test(raw)) return false;
  if (/\bplay\s+/.test(raw) && !/^(don't|do not|never)\s+play\b/.test(raw)) {
    return false;
  }

  const t = raw.replace(/[.!?…]+$/g, "").trim();

  const patterns: RegExp[] = [
    /^(pause|pause\s+it|pause\s+the\s+music|pause\s+playback)(\s+please)?$/,
    /^(please\s+)?pause(\s+the\s+music|\s+it)?$/,
    /^(can you|could you)\s+pause(\s+the\s+music|\s+it)?\??$/,
    /^(hold|mute)\s+(the\s+)?music$/,
    /^(resume|unpause)(\s+playback|\s+the\s+music|\s+playing)?(\s+please)?$/,
    /^(please\s+)?(resume|unpause)$/,
    /^(can you|could you)\s+(resume|unpause)(\s+the\s+music)?\??$/,
    /^continue(\s+the\s+music|\s+playing)?(\s+please)?$/,
    /^(skip|skip\s+it|skip\s+this|next(\s+track|\s+song)?)(\s+please)?$/,
    /^(please\s+)?skip(\s+this|\s+it)?$/,
    /^(can you|could you)\s+skip(\s+this)?\??$/,
    /^(stop\s+the\s+music|stop\s+playing|stop\s+playback)(\s+please)?$/,
    /^(please\s+)?stop\s+the\s+music$/,
    /^(can you|could you)\s+stop\s+(the\s+music|playing)\??$/,
  ];

  if (patterns.some((p) => p.test(t))) {
    return true;
  }

  // Short, single-intent phrases the model often paraphrases (not matched above).
  const loose = raw.replace(/[.!?…]+$/g, "").trim();
  if (loose.length > 160) return false;
  if (/\bplay\s+[a-z0-9]/i.test(loose)) return false;
  const wantsStop =
    /\bstop\s+(the\s+)?music\b/.test(loose) || /\bstop\s+playing\b/.test(loose);
  const wantsResume =
    /\b(unpause|resume)\b/.test(loose) ||
    /\bcontinue\s+(the\s+)?(music|playing)\b/.test(loose);
  const wantsSkip =
    /\bskip\b/.test(loose) || /\bnext\s+(track|song)\b/.test(loose);
  const wantsPause =
    /\bpause(d|ing)?\b/.test(loose) ||
    /\bhold\s+(the\s+)?music\b/.test(loose) ||
    /\bmute\s+(the\s+)?music\b/.test(loose);
  const n = [wantsStop, wantsResume, wantsSkip, wantsPause].filter(
    Boolean,
  ).length;
  return n === 1;
}

export type PlaybackTransportKind = "pause" | "resume" | "skip" | "stop";

/**
 * Which dedicated music action should run (PLAY_AUDIO must not be used).
 */
export function classifyPlaybackTransportIntent(
  text: string,
): PlaybackTransportKind | null {
  if (!isPlaybackTransportControlOnlyMessage(text)) return null;
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[.!?…]+$/g, "")
    .trim();

  if (
    /\bstop\s+(the\s+)?music\b/.test(t) ||
    /\bstop\s+playing\b/.test(t) ||
    /\bstop\s+playback\b/.test(t)
  ) {
    return "stop";
  }
  if (
    /\b(unpause|resume)\b/.test(t) ||
    /\bcontinue\s+(the\s+)?(music|playing)\b/.test(t)
  ) {
    return "resume";
  }
  if (/\bskip\b/.test(t) || /\bnext\s+(track|song)\b/.test(t)) {
    return "skip";
  }
  return "pause";
}
