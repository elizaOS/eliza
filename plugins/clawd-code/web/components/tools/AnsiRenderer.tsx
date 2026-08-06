"use client";

import React from "react";

// 16-color ANSI palette (matches common terminal defaults)
const FG_COLORS: Record<number, string> = {
  30: "#3d3d3d",
  31: "#cc0000",
  32: "#4e9a06",
  33: "#c4a000",
  34: "#3465a4",
  35: "#75507b",
  36: "#06989a",
  37: "#d3d7cf",
  90: "#555753",
  91: "#ef2929",
  92: "#8ae234",
  93: "#fce94f",
  94: "#729fcf",
  95: "#ad7fa8",
  96: "#34e2e2",
  97: "#eeeeec",
};

const BG_COLORS: Record<number, string> = {
  40: "#3d3d3d",
  41: "#cc0000",
  42: "#4e9a06",
  43: "#c4a000",
  44: "#3465a4",
  45: "#75507b",
  46: "#06989a",
  47: "#d3d7cf",
  100: "#555753",
  101: "#ef2929",
  102: "#8ae234",
  103: "#fce94f",
  104: "#729fcf",
  105: "#ad7fa8",
  106: "#34e2e2",
  107: "#eeeeec",
};

// 256-color palette
function get256Color(n: number): string {
  if (n < 16) {
    const fg = FG_COLORS[n + 30] ?? FG_COLORS[n + 82]; // handle 0-7 and 8-15
    if (fg) return fg;
  }
  if (n < 232) {
    // 6×6×6 color cube
    const i = n - 16;
    const b = i % 6;
    const g = Math.floor(i / 6) % 6;
    const r = Math.floor(i / 36);
    const toHex = (v: number) =>
      (v === 0 ? 0 : 55 + v * 40).toString(16).padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }
  // Grayscale ramp
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

interface Segment {
  text: string;
  style: AnsiStyle;
}

function parseAnsi(input: string): Segment[] {
  const segments: Segment[] = [];
  let current: AnsiStyle = {};
  let pos = 0;
  let textStart = 0;

  const pushSegment = (end: number) => {
    const text = input.slice(textStart, end);
    if (text) {
      segments.push({ text, style: { ...current } });
    }
  };

  while (pos < input.length) {
    const esc = input.indexOf("\x1b[", pos);
    if (esc === -1) break;

    pushSegment(esc);

    // Find the end of the escape sequence (letter terminator)
    let seqEnd = esc + 2;
    while (seqEnd < input.length && !/[A-Za-z]/.test(input[seqEnd])) {
      seqEnd++;
    }
    const terminator = input[seqEnd];
    const params = input.slice(esc + 2, seqEnd).split(";").map(Number);

    if (terminator === "m") {
      // SGR sequence
      let i = 0;
      while (i < params.length) {
        const p = params[i];
        if (p === 0 || isNaN(p)) {
          current = {};
        } else if (p === 1) {
          current.bold = true;
        } else if (p === 2) {
          current.dim = true;
        } else if (p === 3) {
          current.italic = true;
        } else if (p === 4) {
          current.underline = true;
        } else if (p === 9) {
          current.strikethrough = true;
        } else if (p === 22) {
          current.bold = false;
          current.dim = false;
        } else if (p === 23) {
          current.italic = false;
        } else if (p === 24) {
          current.underline = false;
        } else if (p === 29) {
          current.strikethrough = false;
        } else if (p >= 30 && p <= 37) {
          current.color = FG_COLORS[p];
        } else if (p === 38) {
          if (params[i + 1] === 5 && params[i + 2] !== undefined) {
            current.color = get256Color(params[i + 2]);
            i += 2;
          } else if (
            params[i + 1] === 2 &&
            params[i + 2] !== undefined &&
            params[i + 3] !== undefined &&
            params[i + 4] !== undefined
          ) {
            current.color = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`;
            i += 4;
          }
        } else if (p === 39) {
          delete current.color;
        } else if (p >= 40 && p <= 47) {
          current.background = BG_COLORS[p];
        } else if (p === 48) {
          if (params[i + 1] === 5 && params[i + 2] !== undefined) {
            current.background = get256Color(params[i + 2]);
            i += 2;
          } else if (
            params[i + 1] === 2 &&
            params[i + 2] !== undefined &&
            params[i + 3] !== undefined &&
            params[i + 4] !== undefined
          ) {
            current.background = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`;
            i += 4;
          }
        } else if (p === 49) {
          delete current.background;
        } else if (p >= 90 && p <= 97) {
          current.color = FG_COLORS[p];
        } else if (p >= 100 && p <= 107) {
          current.background = BG_COLORS[p];
        }
        i++;
      }
    }

    pos = seqEnd + 1;
    textStart = pos;
  }

  pushSegment(input.length);
  return segments;
}

function segmentToStyle(style: AnsiStyle): React.CSSProperties {
  return {
    color: style.color,
    backgroundColor: style.background,
    fontWeight: style.bold ? "bold" : undefined,
    opacity: style.dim ? 0.7 : undefined,
    fontStyle: style.italic ? "italic" : undefined,
    textDecoration: [
      style.underline ? "underline" : "",
      style.strikethrough ? "line-through" : "",
    ]
      .filter(Boolean)
      .join(" ") || undefined,
  };
}

interface AnsiRendererProps {
  text: string;
  className?: string;
}

export function AnsiRenderer({ text, className }: AnsiRendererProps) {
  const lines = text.split("\n");

  return (
    <span className={className}>
      {lines.map((line, lineIdx) => (
        <span key={lineIdx}>
          {lineIdx > 0 && "\n"}
          {parseAnsi(line).map((seg, segIdx) => (
            <span key={segIdx} style={segmentToStyle(seg.style)}>
              {seg.text}
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}
