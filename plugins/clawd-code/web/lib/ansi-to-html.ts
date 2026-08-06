/**
 * ANSI escape code → HTML/CSS utilities.
 * Re-exports the full AnsiRenderer parser and adds text-stripping helpers.
 */

// ─── Strip ANSI ───────────────────────────────────────────────────────────────

/** Regex matching ANSI/VT100 escape sequences. */
const ANSI_RE = /\x1b\[[0-9;]*[mGKHF]|\x1b\][^\x07]*\x07|\x1b[()][AB012]/g;

/** Remove all ANSI escape sequences from a string. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** Returns true if the string contains any ANSI escape sequences. */
export function hasAnsi(text: string): boolean {
  ANSI_RE.lastIndex = 0;
  return ANSI_RE.test(text);
}

// ─── ANSI → inline HTML spans ─────────────────────────────────────────────────

// 16-color ANSI foreground palette (matches common terminal defaults / xterm256)
const FG: Record<number, string> = {
  30: "#3d3d3d", 31: "#cc0000", 32: "#4e9a06", 33: "#c4a000",
  34: "#3465a4", 35: "#75507b", 36: "#06989a", 37: "#d3d7cf",
  90: "#555753", 91: "#ef2929", 92: "#8ae234", 93: "#fce94f",
  94: "#729fcf", 95: "#ad7fa8", 96: "#34e2e2", 97: "#eeeeec",
};

const BG: Record<number, string> = {
  40: "#3d3d3d", 41: "#cc0000", 42: "#4e9a06", 43: "#c4a000",
  44: "#3465a4", 45: "#75507b", 46: "#06989a", 47: "#d3d7cf",
  100: "#555753", 101: "#ef2929", 102: "#8ae234", 103: "#fce94f",
  104: "#729fcf", 105: "#ad7fa8", 106: "#34e2e2", 107: "#eeeeec",
};

function get256Color(n: number): string {
  if (n < 16) return FG[n + 30] ?? FG[n + 82] ?? "#ffffff";
  if (n < 232) {
    const i = n - 16;
    const b = i % 6, g = Math.floor(i / 6) % 6, r = Math.floor(i / 36);
    const h = (v: number) => (v === 0 ? 0 : 55 + v * 40).toString(16).padStart(2, "0");
    return `#${h(r)}${h(g)}${h(b)}`;
  }
  const gray = (n - 232) * 10 + 8;
  const hex = gray.toString(16).padStart(2, "0");
  return `#${hex}${hex}${hex}`;
}

interface AnsiStyle {
  color?: string;
  background?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
}

export interface AnsiSegment {
  text: string;
  style: AnsiStyle;
}

/**
 * Parse an ANSI-encoded string into styled text segments.
 * This is the core parser used by AnsiRenderer and can be used directly
 * when you need to process segments programmatically.
 */
export function parseAnsiSegments(input: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let current: AnsiStyle = {};
  let pos = 0;
  let textStart = 0;

  const push = (end: number) => {
    const text = input.slice(textStart, end);
    if (text) segments.push({ text, style: { ...current } });
  };

  while (pos < input.length) {
    const esc = input.indexOf("\x1b[", pos);
    if (esc === -1) break;
    push(esc);

    let seqEnd = esc + 2;
    while (seqEnd < input.length && !/[A-Za-z]/.test(input[seqEnd])) seqEnd++;
    const term = input[seqEnd];
    const params = input.slice(esc + 2, seqEnd).split(";").map(Number);

    if (term === "m") {
      let i = 0;
      while (i < params.length) {
        const p = params[i];
        if (p === 0 || isNaN(p)) { current = {}; }
        else if (p === 1)  { current.bold = true; }
        else if (p === 2)  { current.dim = true; }
        else if (p === 3)  { current.italic = true; }
        else if (p === 4)  { current.underline = true; }
        else if (p === 9)  { current.strikethrough = true; }
        else if (p === 22) { current.bold = false; current.dim = false; }
        else if (p === 23) { current.italic = false; }
        else if (p === 24) { current.underline = false; }
        else if (p === 29) { current.strikethrough = false; }
        else if (p >= 30 && p <= 37)   { current.color = FG[p]; }
        else if (p === 38) {
          if (params[i+1] === 5 && params[i+2] !== undefined) {
            current.color = get256Color(params[i+2]); i += 2;
          } else if (params[i+1] === 2 && params[i+4] !== undefined) {
            current.color = `rgb(${params[i+2]},${params[i+3]},${params[i+4]})`; i += 4;
          }
        }
        else if (p === 39) { delete current.color; }
        else if (p >= 40 && p <= 47)   { current.background = BG[p]; }
        else if (p === 48) {
          if (params[i+1] === 5 && params[i+2] !== undefined) {
            current.background = get256Color(params[i+2]); i += 2;
          } else if (params[i+1] === 2 && params[i+4] !== undefined) {
            current.background = `rgb(${params[i+2]},${params[i+3]},${params[i+4]})`; i += 4;
          }
        }
        else if (p === 49) { delete current.background; }
        else if (p >= 90 && p <= 97)   { current.color = FG[p]; }
        else if (p >= 100 && p <= 107) { current.background = BG[p]; }
        i++;
      }
    }

    pos = seqEnd + 1;
    textStart = pos;
  }

  push(input.length);
  return segments;
}

/**
 * Convert an ANSI string to a plain HTML string with inline styles.
 * Each styled run is wrapped in a `<span style="...">`.
 * Suitable for dangerouslySetInnerHTML when the source is trusted server output.
 */
export function ansiToHtml(text: string): string {
  const segments = parseAnsiSegments(text);
  return segments
    .map(({ text: t, style }) => {
      const parts: string[] = [];
      if (style.color)      parts.push(`color:${style.color}`);
      if (style.background) parts.push(`background:${style.background}`);
      if (style.bold)       parts.push("font-weight:bold");
      if (style.dim)        parts.push("opacity:0.7");
      if (style.italic)     parts.push("font-style:italic");
      const deco = [style.underline && "underline", style.strikethrough && "line-through"]
        .filter(Boolean).join(" ");
      if (deco) parts.push(`text-decoration:${deco}`);

      const escaped = t
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

      return parts.length ? `<span style="${parts.join(";")}">${escaped}</span>` : escaped;
    })
    .join("");
}
