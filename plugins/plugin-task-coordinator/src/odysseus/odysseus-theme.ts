// odysseus design system, ported 1:1 from github.com/pewdiepie-archdaemon/odysseus
// (static/js/theme.js THEMES + the inline theme bootstrap in static/index.html +
// static/style.css). MIT, ported with permission; credited in ACKNOWLEDGMENTS.
//
// Three exports, mirroring the existing ORCHESTRATOR_THEME pattern so the agent
// (Node) can import this plugin's view manifest without ever evaluating a .css
// file (see @elizaos/ui CLAUDE.md — index.ts is CSS-free on purpose):
//   • ODYSSEUS_THEMES — the 16 built-in 5-colour palettes (verbatim from
//     theme.js), + buildThemeVars(palette) which derives the full root CSS-var
//     set: odysseus's own syntax-highlight HSL derivation PLUS the eliza
//     semantic-token remaps (--card/--txt/--muted/--accent/--ok/…) so reused
//     eliza components (ConversationBlockView, ReasoningCell, DiffView,
//     MarkdownText) inherit the active odysseus theme for free.
//   • themeVars(name) — convenience: buildThemeVars for a named preset.
//   • ODYSSEUS_CSS — structural rules that can't be inline (pseudo-elements,
//     :hover, @keyframes, ::-webkit-scrollbar). Rendered once via a <style> tag
//     inside OdysseusShell, scoped under .odysseus-root so nothing leaks.

import type { CSSProperties } from "react";

export type CssVarStyle = CSSProperties & Record<`--${string}`, string>;

export interface ThemePalette {
  bg: string;
  fg: string;
  panel: string;
  border: string;
  red: string;
  advanced?: {
    sendBtnBg?: string;
    sendBtnHover?: string;
    userBubbleBg?: string;
    aiBubbleBg?: string;
    inputBg?: string;
  };
}

export type ThemeName = string;

/** odysseus's built-in theme palettes (static/js/theme.js `THEMES`), 1:1. */
export const ODYSSEUS_THEMES: Record<string, ThemePalette> = {
  dark: {
    bg: "#282c34",
    fg: "#9cdef2",
    panel: "#111111",
    border: "#355a66",
    red: "#e06c75",
  },
  light: {
    bg: "#f0ebe3",
    fg: "#5a5248",
    panel: "#faf6f0",
    border: "#d4cdc2",
    red: "#c47d5a",
  },
  midnight: {
    bg: "#0d1117",
    fg: "#c9d1d9",
    panel: "#161b22",
    border: "#30363d",
    red: "#f85149",
  },
  paper: {
    bg: "#faf8f5",
    fg: "#3b3836",
    panel: "#ffffff",
    border: "#d5d0c8",
    red: "#c5ac4a",
  },
  cyberpunk: {
    bg: "#0a0a0f",
    fg: "#0ff0fc",
    panel: "#12101a",
    border: "#9b30ff",
    red: "#e040fb",
  },
  retrowave: {
    bg: "#1a1a2e",
    fg: "#e94560",
    panel: "#16213e",
    border: "#533483",
    red: "#e94560",
  },
  forest: {
    bg: "#1b2a1b",
    fg: "#a8d5a2",
    panel: "#142414",
    border: "#3d6b3d",
    red: "#7cb871",
  },
  ocean: {
    bg: "#0b1a2c",
    fg: "#64d2ff",
    panel: "#091422",
    border: "#1e5074",
    red: "#4facfe",
  },
  ume: {
    bg: "#2b1b2e",
    fg: "#f5c2e7",
    panel: "#1e1420",
    border: "#6c4675",
    red: "#f5a0c0",
  },
  copper: {
    bg: "#1c1410",
    fg: "#e8c39e",
    panel: "#140f0a",
    border: "#7a5533",
    red: "#d4764e",
  },
  terminal: {
    bg: "#000000",
    fg: "#00ff41",
    panel: "#0a0a0a",
    border: "#003b00",
    red: "#00ff41",
  },
  organs: {
    bg: "#0a0406",
    fg: "#efe1c8",
    panel: "#15080a",
    border: "#3a1519",
    red: "#c83240",
  },
  lavender: {
    bg: "#f3eef8",
    fg: "#3d3551",
    panel: "#faf7ff",
    border: "#cec3de",
    red: "#9b6dcc",
  },
  gpt: {
    bg: "#212121",
    fg: "#ececec",
    panel: "#171717",
    border: "#424242",
    red: "#949494",
    advanced: {
      sendBtnBg: "#949494",
      sendBtnHover: "#7f7f7f",
      userBubbleBg: "#2f2f2f",
      aiBubbleBg: "#171717",
      inputBg: "#2f2f2f",
    },
  },
  claude: {
    bg: "#262624",
    fg: "#f5f4f0",
    panel: "#30302e",
    border: "#4a4a47",
    red: "#c6613f",
  },
  cute: {
    bg: "#fff0f5",
    fg: "#d4608a",
    panel: "#fff8fa",
    border: "#f0c0d0",
    red: "#ff6b9d",
  },
};

export const DEFAULT_THEME = "dark";

export type ThemeFont = "mono" | "sans" | "serif";
export type ThemeDensity = "compact" | "comfortable" | "spacious";

/** odysseus font choices (static/js/theme.js FONT_MAP), 1:1. */
export const FONT_MAP: Record<ThemeFont, string> = {
  mono: "'Fira Code', ui-monospace, monospace",
  sans: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
};

// HSL helpers + syntax-highlight derivation, ported verbatim from the odysseus
// index.html theme bootstrap — so every preset gets faithful --hl-* colours.
function h2hsl(hex: string): [number, number, number] {
  const s = hex.replace("#", "");
  const r = Number.parseInt(s.substring(0, 2), 16) / 255;
  const g = Number.parseInt(s.substring(2, 4), 16) / 255;
  const b = Number.parseInt(s.substring(4, 6), 16) / 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  let h = 0;
  let sv = 0;
  if (mx !== mn) {
    const d = mx - mn;
    sv = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (mx === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h * 360, sv * 100, l * 100];
}

function hsl2h(h: number, sv: number, l: number): string {
  const hh = ((h % 360) + 360) % 360;
  const s = Math.max(0, Math.min(100, sv)) / 100;
  const ll = Math.max(0, Math.min(100, l)) / 100;
  const a = s * Math.min(ll, 1 - ll);
  const f = (n: number) => {
    const k = (n + hh / 30) % 12;
    return ll - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  const th = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${th(f(0))}${th(f(8))}${th(f(4))}`;
}

/** Derive the full root CSS-var set from a 5-colour odysseus palette. */
export function buildThemeVars(c: ThemePalette): CssVarStyle {
  const bH = h2hsl(c.bg);
  const fH = h2hsl(c.fg);
  const rH = h2hsl(c.red);
  const dark = bH[2] < 50;
  const mix = (base: string, pct: number) =>
    `color-mix(in srgb, ${base} ${pct}%, transparent)`;
  const vars: CssVarStyle = {
    "--bg": c.bg,
    "--fg": c.fg,
    "--panel": c.panel,
    "--border": c.border,
    "--red": c.red,
    "--green": "#50fa7b",
    "--warn": "#f0ad4e",
    "--brand-color": c.red,
    "--model-dot": mix(c.fg, 30),
    "--hl-bg": hsl2h(
      bH[0],
      bH[1],
      dark ? Math.max(bH[2] - 4, 0) : Math.min(bH[2] + 4, 100),
    ),
    "--hl-fg": c.fg,
    "--hl-keyword": hsl2h(
      (rH[0] + 280) % 360,
      Math.min(rH[1] + 10, 80),
      dark ? 70 : 45,
    ),
    "--hl-string": hsl2h(40, Math.min(fH[1] + 20, 70), dark ? 72 : 42),
    "--hl-comment": hsl2h(
      fH[0],
      Math.max(fH[1] - 20, 5),
      fH[2] * 0.5 + bH[2] * 0.5,
    ),
    "--hl-function": hsl2h(210, Math.min(fH[1] + 20, 75), dark ? 70 : 45),
    "--hl-number": hsl2h(20, Math.min(fH[1] + 15, 65), dark ? 68 : 48),
    "--hl-builtin": hsl2h(180, Math.min(fH[1] + 15, 60), dark ? 65 : 40),
    "--hl-variable": hsl2h((fH[0] + 30) % 360, Math.min(fH[1] + 5, 60), fH[2]),
    "--hl-params": hsl2h(
      fH[0],
      Math.max(fH[1] - 5, 10),
      dark ? Math.min(fH[2] + 8, 85) : Math.max(fH[2] - 8, 25),
    ),
    "--bg-elevated": `color-mix(in srgb, ${c.fg} 6%, ${c.bg})`,
    "--card": c.panel,
    "--card-foreground": c.fg,
    "--surface": c.panel,
    "--text": c.fg,
    "--txt": c.fg,
    "--text-strong": dark ? "#ffffff" : "#000000",
    "--chat-text": c.fg,
    "--muted": mix(c.fg, 56),
    "--muted-strong": mix(c.fg, 74),
    "--border-strong": mix(c.fg, 22),
    "--border-hover": mix(c.fg, 22),
    "--bg-accent": mix(c.red, 8),
    "--bg-hover": mix(c.fg, 8),
    "--bg-muted": mix(c.fg, 12),
    "--accent": c.red,
    "--accent-subtle": mix(c.red, 14),
    "--ok": "#50fa7b",
    "--destructive": c.red,
    "--info": mix(c.fg, 74),
    "--ring": c.red,
    "--input": c.advanced?.inputBg ?? c.panel,
    "--focus": mix(c.fg, 14),
    "--status-info-bg": mix(c.fg, 6),
    "--link-color": c.fg,
    "--link-hover-color": c.red,
    "--scrollbar-track": c.panel,
    "--scrollbar-thumb-start": c.red,
    "--scrollbar-thumb-mid": c.red,
    "--scrollbar-thumb-end": c.red,
  };
  if (c.advanced?.userBubbleBg)
    vars["--user-bubble-bg"] = c.advanced.userBubbleBg;
  if (c.advanced?.aiBubbleBg) vars["--ai-bubble-bg"] = c.advanced.aiBubbleBg;
  if (c.advanced?.inputBg) vars["--input-bg"] = c.advanced.inputBg;
  if (c.advanced?.sendBtnBg) vars["--send-btn-bg"] = c.advanced.sendBtnBg;
  return vars;
}

export function themeVars(name: ThemeName): CssVarStyle {
  return buildThemeVars(
    ODYSSEUS_THEMES[name] ?? ODYSSEUS_THEMES[DEFAULT_THEME],
  );
}

// Structural CSS — verbatim odysseus rules, re-prefixed `od-` and scoped under
// .odysseus-root so they never collide with or leak into the rest of eliza.
export const ODYSSEUS_CSS = `
.odysseus-root { display:flex; height:100%; min-height:0; width:100%; overflow:hidden; position:relative; isolation:isolate;
  background:var(--bg); color:var(--fg);
  font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif; }

/* ── icon rail ── */
.odysseus-root .od-icon-rail { width:48px; flex-shrink:0; display:flex; flex-direction:column;
  align-items:center; gap:4px; padding:14px 0; background:var(--panel);
  border-right:1px solid var(--border); }
.odysseus-root .od-rail-btn { width:32px; height:32px; display:flex; align-items:center; justify-content:center;
  border:none; background:none; color:var(--fg); opacity:.45; border-radius:8px; cursor:pointer;
  transition:opacity .12s, background .12s; }
.odysseus-root .od-rail-btn:hover { opacity:1; background:color-mix(in srgb, var(--fg) 8%, transparent); }
.odysseus-root .od-rail-btn.active { opacity:1; color:var(--red); background:color-mix(in srgb, var(--red) 12%, transparent); }
.odysseus-root .od-rail-spacer { flex:1; }

/* ── sidebar ── */
.odysseus-root .od-sidebar { width:240px; flex-shrink:0; display:flex; flex-direction:column;
  overflow:hidden; min-height:0; background:var(--sidebar-bg, var(--panel)); position:relative;
  border-right:1px solid var(--border); box-shadow:0 4px 12px rgba(0,0,0,.1); backdrop-filter:blur(10px); }
.odysseus-root .od-sidebar-resize-handle { position:absolute; top:0; right:0; width:5px; height:100%;
  cursor:col-resize; z-index:5; touch-action:none; border:none; padding:0; margin:0;
  background:transparent; appearance:none; }
.odysseus-root .od-sidebar-resize-handle:hover,
.odysseus-root .od-sidebar-resize-handle:focus-visible { background:color-mix(in srgb, var(--red) 30%, transparent); outline:none; }
.odysseus-root .od-sidebar.od-collapsed { width:0; border-right:none; }
.odysseus-root .od-sidebar-header { display:flex; align-items:center; gap:8px;
  padding:15px 12px 6px; flex-shrink:0; min-height:40px; }
.odysseus-root .od-sidebar-brand-title { font-size:1rem; font-weight:600; line-height:1.35;
  color:var(--brand-color, var(--red)); white-space:nowrap; user-select:none; cursor:pointer;
  background:none; border:none; padding:0; font-family:inherit; text-align:left; }
.odysseus-root .od-sidebar-inner { flex:1; overflow-y:auto; overflow-x:hidden; overscroll-behavior-y:none;
  scrollbar-width:none; display:flex; flex-direction:column; gap:0; padding:10px 8px 8px; min-height:0; }
.odysseus-root .od-sidebar-inner::-webkit-scrollbar { display:none; }
.odysseus-root .od-list-item { display:flex; gap:6px; align-items:center; padding:3px 8px; margin:0;
  border-radius:4px; border:1px solid transparent; line-height:1.3; font-size:13px; color:var(--fg);
  background:transparent; transition:background .08s; cursor:pointer; }
.odysseus-root .od-list-item:hover { background:color-mix(in srgb, var(--red) 8%, transparent); }
.odysseus-root .od-list-item.active { background:color-mix(in srgb, var(--red) 10%, transparent);
  border-color:var(--red); }
.odysseus-root .od-list-item .od-grow { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.odysseus-root .od-list-item .od-sub { font-size:10px; opacity:.5; white-space:nowrap; }
.odysseus-root .od-thread-row { position:relative; display:flex; align-items:center; }
.odysseus-root .od-thread-row .od-thread-main { flex:1; min-width:0; }
.odysseus-root .od-thread-menu-btn { position:absolute; right:4px; top:50%; transform:translateY(-50%);
  width:22px; height:22px; display:flex; align-items:center; justify-content:center; border:none;
  background:var(--panel); color:var(--fg); opacity:0; border-radius:4px; cursor:pointer; transition:opacity .12s; }
.odysseus-root .od-thread-row:hover .od-thread-menu-btn { opacity:.55; }
.odysseus-root .od-thread-menu-btn:hover { opacity:1; background:color-mix(in srgb, var(--fg) 10%, transparent); }
.odysseus-root .od-thread-menu { position:absolute; right:4px; top:calc(50% + 14px); z-index:30;
  background:var(--panel); border:1px solid var(--border); border-radius:8px; box-shadow:0 6px 20px rgba(0,0,0,.4);
  min-width:120px; overflow:hidden; padding:4px; }
.odysseus-root .od-thread-menu button { display:flex; align-items:center; gap:7px; width:100%; text-align:left;
  padding:6px 10px; border:none; background:none; color:var(--fg); font-size:12px; border-radius:4px; cursor:pointer; }
.odysseus-root .od-thread-menu button:hover { background:color-mix(in srgb, var(--fg) 8%, transparent); }
.odysseus-root .od-thread-menu button.od-danger { color:var(--red); }
.odysseus-root .od-thread-pin-dot { flex-shrink:0; margin-right:5px; color:var(--accent, var(--red)); opacity:.85; }
.odysseus-root .od-thread-rename { width:100%; box-sizing:border-box; padding:3px 8px; margin:1px 0; font-size:13px;
  background:var(--bg); color:var(--fg); border:1px solid var(--red); border-radius:4px; outline:none; font-family:inherit; }
.odysseus-root .od-section { padding:0; margin:0; }
.odysseus-root .od-section-header-flex { display:flex; align-items:center; gap:6px; padding:8px;
  margin:1px 0; border-radius:4px; height:29px; box-sizing:border-box; }
.odysseus-root .od-section-title { flex:1; display:flex; align-items:center; gap:6px; margin:0;
  font-size:10px; font-weight:400; line-height:1; color:var(--fg); user-select:none;
  text-transform:none; letter-spacing:0; }
.odysseus-root .od-sidebar-user-bar { display:flex; align-items:center; justify-content:space-between;
  padding:12px; flex-shrink:0; gap:4px; min-height:48px; border-top:1px solid color-mix(in srgb, var(--fg) 8%, transparent); }
.odysseus-root .od-user-left { display:flex; align-items:center; gap:10px; flex:1; min-width:0;
  cursor:pointer; padding:6px 8px; border-radius:8px; transition:background .15s; }
.odysseus-root .od-user-left:hover { background:color-mix(in srgb, var(--fg) 6%, transparent); }
.odysseus-root .od-user-avatar { width:24px; height:24px; border-radius:50%; display:flex; align-items:center;
  justify-content:center; font-size:10px; font-weight:600; color:var(--fg); opacity:.7; flex-shrink:0;
  text-transform:uppercase; background:color-mix(in srgb, var(--fg) 12%, transparent); }
.odysseus-root .od-user-name { font-size:9.75px; font-weight:500; color:var(--fg); opacity:.8;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.odysseus-root .od-user-btn { background:none; border:none; color:var(--fg); opacity:.35; cursor:pointer;
  padding:6px; border-radius:6px; display:flex; align-items:center; transition:opacity .12s, background .12s; }
.odysseus-root .od-user-btn:hover { opacity:1; background:color-mix(in srgb, var(--fg) 8%, transparent); }

/* ── chat container ── */
.odysseus-root .od-chat-container { flex:1; display:flex; flex-direction:column; padding:0 16px;
  overflow:hidden; position:relative; min-height:0; min-width:0; margin-top:8px; }
.odysseus-root .od-chat-top-bar { display:flex; align-items:center; justify-content:center; flex-shrink:0;
  position:relative; z-index:2; padding:5px 0 0; min-height:25px; }
.odysseus-root .od-chat-meta { font-size:.75em; line-height:1; color:color-mix(in srgb, var(--fg) 40%, transparent);
  white-space:nowrap; display:flex; align-items:center; gap:6px; }

/* ── message log ── */
.odysseus-root .od-chat-history { flex:1; overflow-y:auto; overflow-x:hidden; overscroll-behavior-y:none;
  margin-bottom:8px; min-height:0; --chat-max:800px; display:flex; flex-direction:column;
  padding-left:max(0px, calc((100% - var(--chat-max)) / 2));
  padding-right:max(12px, calc((100% - var(--chat-max)) / 2 + 12px)); }
.odysseus-root .od-chat-history::-webkit-scrollbar { width:8px; }
.odysseus-root .od-chat-history::-webkit-scrollbar-track { background:var(--panel); }
.odysseus-root .od-chat-history::-webkit-scrollbar-thumb { background-color:var(--red); border-radius:4px;
  border:2px solid var(--panel); }
.odysseus-root .od-chat-history::-webkit-scrollbar-thumb:hover { background-color:color-mix(in srgb, var(--red) 80%, white); }
.odysseus-root .od-msg { margin:8px 0; position:relative; display:flex; flex-direction:column;
  line-height:1.4; word-wrap:break-word; overflow-wrap:break-word; animation:od-msg-enter .3s ease-out both; }
.odysseus-root .od-msg-user { align-items:flex-end; align-self:flex-end; margin-left:auto; margin-right:8px;
  background:var(--user-bubble-bg, color-mix(in srgb, var(--fg) 8%, var(--bg))); border:1px solid var(--border);
  border-radius:18px 18px 0 18px; width:fit-content; max-width:85%; min-width:80px; padding:10px 12px; }
.odysseus-root .od-msg-ai { align-items:flex-start; align-self:flex-start; margin-right:auto; margin-left:8px;
  background:var(--ai-bubble-bg, var(--panel)); border:1px solid var(--border);
  border-radius:18px 18px 18px 0; width:85%; max-width:85%; min-width:80px; padding:10px 12px; }
.odysseus-root .od-role { font-weight:600; margin-bottom:6px; display:flex; align-items:center; gap:6px;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:.85em; color:var(--fg); }
.odysseus-root .od-role::before { content:''; width:8px; height:8px; border-radius:50%;
  background:var(--model-dot); flex-shrink:0; }
.odysseus-root .od-msg-user .od-role { color:color-mix(in srgb, var(--fg) 60%, transparent); }
.odysseus-root .od-msg-user .od-role::before { background:color-mix(in srgb, var(--fg) 40%, transparent); }
.odysseus-root .od-body { width:100%; white-space:normal; word-break:break-word; overflow-wrap:anywhere;
  line-height:1.5; font-size:.95em; color:var(--fg); }
.odysseus-root .od-body > * { margin-top:8px; margin-bottom:8px; }
.odysseus-root .od-body > *:first-child { margin-top:0; }
.odysseus-root .od-body > *:last-child { margin-bottom:0; }
.odysseus-root .od-msg-time { font-size:.7rem; color:color-mix(in srgb, var(--fg) 45%, transparent); margin-top:6px; }
.odysseus-root .od-msg-cells { width:100%; max-width:var(--chat-max); margin:0 auto; }

/* ── composer ── */
.odysseus-root .od-input-bar { position:relative; background:var(--input-bg, var(--panel)); border:1px solid var(--input-border, var(--border));
  border-radius:16px; padding:10px 12px; display:flex; flex-direction:column; gap:8px;
  max-width:800px; margin:0 auto 12px; width:100%; }
.odysseus-root .od-slash-menu { position:absolute; bottom:calc(100% + 6px); left:0; right:0; z-index:10;
  background:var(--panel); border:1px solid var(--border); border-radius:12px; box-shadow:0 8px 24px rgba(0,0,0,.4);
  overflow:hidden; padding:4px; }
.odysseus-root .od-slash-item { display:flex; align-items:center; gap:10px; width:100%; padding:7px 10px;
  border:none; background:none; color:var(--fg); font-size:13px; text-align:left; border-radius:6px; cursor:pointer; }
.odysseus-root .od-slash-item.active { background:color-mix(in srgb, var(--red) 12%, transparent); }
.odysseus-root .od-slash-name { font-family:'Fira Code', ui-monospace, monospace; color:var(--red);
  font-weight:600; min-width:64px; }
.odysseus-root .od-slash-label { opacity:.65; }
.odysseus-root .od-input-top { width:100%; position:relative; display:flex; align-items:flex-start; gap:8px; }
.odysseus-root .od-input-top textarea { flex:1; width:100%; background:transparent; border:none; outline:none;
  resize:none; font-size:14px; line-height:1.5; color:var(--fg); min-height:24px; max-height:200px;
  padding:0; font-family:inherit; }
.odysseus-root .od-input-top textarea::placeholder { color:color-mix(in srgb, var(--fg) 35%, transparent); }
.odysseus-root .od-model-picker-btn { display:inline-flex; align-items:center; gap:4px; height:21px; padding:0 6px;
  font-size:11px; font-weight:500; font-family:inherit; background:none; border:1px solid transparent;
  border-radius:4px; color:color-mix(in srgb, var(--fg) 40%, transparent); cursor:pointer; white-space:nowrap;
  flex-shrink:0; transition:background .15s, color .15s, border-color .15s; }
.odysseus-root .od-model-picker-btn:hover { border-color:var(--border);
  background:color-mix(in srgb, var(--fg) 8%, transparent); color:var(--fg); }
.odysseus-root .od-input-bottom { display:flex; justify-content:space-between; align-items:center; margin-top:4px; }
.odysseus-root .od-input-left { display:flex; gap:4px; align-items:center; min-width:0; flex:1; }
.odysseus-root .od-input-right { display:flex; gap:8px; align-items:center; flex-shrink:0; }
.odysseus-root .od-icon-btn { width:30px; height:30px; display:flex; align-items:center; justify-content:center;
  background:none; border:none; border-radius:6px; color:color-mix(in srgb, var(--fg) 45%, transparent);
  cursor:pointer; transition:background .12s, color .12s; flex-shrink:0; }
.odysseus-root .od-icon-btn:hover { color:var(--fg); background:color-mix(in srgb, var(--fg) 8%, transparent); }
.odysseus-root .od-icon-btn.active { color:var(--red); background:color-mix(in srgb, var(--red) 12%, transparent); }
.odysseus-root .od-mode-toggle { display:flex; flex-shrink:0; height:28px; border:1px solid var(--border);
  border-radius:10px; overflow:hidden; position:relative; }
.odysseus-root .od-mode-toggle::before { content:''; position:absolute; top:0; left:0; width:50%; height:100%;
  background:color-mix(in srgb, var(--fg) 10%, transparent); border-radius:9px;
  transition:transform .3s cubic-bezier(.34,1.56,.64,1); z-index:0; }
.odysseus-root .od-mode-toggle.od-mode-chat::before { transform:translateX(100%); }
.odysseus-root .od-mode-btn { background:none; border:none; color:color-mix(in srgb, var(--fg) 40%, transparent);
  cursor:pointer; padding:0 10px; font-size:11px; font-weight:500; font-family:inherit; transition:color .2s;
  white-space:nowrap; height:100%; position:relative; z-index:1; }
.odysseus-root .od-mode-btn.active { color:var(--fg); cursor:default; }
.odysseus-root .od-send-btn { background:var(--send-btn-bg, var(--red)); color:#fff; border:none; border-radius:8px;
  min-width:32px; width:32px; height:32px; padding:0; cursor:pointer; display:flex; align-items:center;
  justify-content:center; flex-shrink:0; overflow:hidden;
  transition:background .25s, color .25s, opacity .1s; }
.odysseus-root .od-send-btn:hover { background:color-mix(in srgb, var(--red) 80%, white); }
.odysseus-root .od-send-btn:disabled { opacity:.4; cursor:default; }
.odysseus-root .od-send-btn.od-stop { background:color-mix(in srgb, var(--red) 18%, transparent);
  color:var(--red); }
.odysseus-root .od-send-btn.od-stop:hover { background:color-mix(in srgb, var(--red) 28%, transparent); }

/* ── theme menu ── */
.odysseus-root .od-theme-menu { position:absolute; left:52px; bottom:12px; z-index:60; width:260px;
  background:var(--panel); border:1px solid var(--border); border-radius:12px; box-shadow:0 12px 40px rgba(0,0,0,.45);
  padding:10px; }
.odysseus-root .od-theme-grid { display:grid; grid-template-columns:repeat(2, 1fr); gap:6px; }
.odysseus-root .od-theme-swatch { display:flex; align-items:center; gap:8px; padding:6px 8px; border:1px solid var(--border);
  border-radius:8px; background:none; color:var(--fg); cursor:pointer; font-size:12px; text-align:left;
  transition:border-color .12s; }
.odysseus-root .od-theme-swatch:hover { border-color:var(--red); }
.odysseus-root .od-theme-swatch.active { border-color:var(--red); box-shadow:0 0 0 1px var(--red) inset; }
.odysseus-root .od-theme-chip { width:20px; height:20px; border-radius:6px; flex-shrink:0;
  border:1px solid rgba(255,255,255,.15); }
.odysseus-root .od-theme-name { text-transform:capitalize; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.odysseus-root .od-theme-section { font-size:10px; text-transform:uppercase; letter-spacing:.04em; opacity:.5; margin:10px 2px 4px; }
.odysseus-root .od-theme-row { display:flex; gap:6px; }
.odysseus-root .od-theme-pill { flex:1; padding:5px 8px; border:1px solid var(--border); border-radius:8px;
  background:none; color:var(--fg); font-size:11px; cursor:pointer; text-transform:capitalize; transition:border-color .12s; }
.odysseus-root .od-theme-pill:hover { border-color:var(--red); }
.odysseus-root .od-theme-pill.active { border-color:var(--red); color:var(--red); }
.odysseus-root .od-theme-custom { display:flex; gap:6px; justify-content:space-between; }
.odysseus-root .od-theme-color { display:flex; flex-direction:column; align-items:center; gap:3px; font-size:9px;
  color:color-mix(in srgb, var(--fg) 55%, transparent); text-transform:capitalize; cursor:pointer; }
.odysseus-root .od-theme-color input[type=color] { width:34px; height:24px; border:1px solid var(--border);
  border-radius:6px; background:none; padding:0; cursor:pointer; }
.odysseus-root .od-theme-save { display:flex; gap:6px; margin-top:8px; }
.odysseus-root .od-theme-save-input { flex:1; min-width:0; padding:5px 8px; border:1px solid var(--border);
  border-radius:8px; background:var(--bg); color:var(--fg); font-size:11px; outline:none; }
.odysseus-root .od-theme-saved { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
.odysseus-root .od-theme-saved-item { display:inline-flex; align-items:center; border:1px solid var(--border);
  border-radius:8px; overflow:hidden; }
.odysseus-root .od-theme-saved-name { background:none; border:none; color:var(--fg); font-size:11px;
  padding:4px 8px; cursor:pointer; text-transform:capitalize; }
.odysseus-root .od-theme-saved-del { background:none; border:none; border-left:1px solid var(--border);
  color:color-mix(in srgb, var(--fg) 45%, transparent); font-size:10px; padding:4px 7px; cursor:pointer; }
.odysseus-root .od-theme-saved-del:hover { color:var(--red); }

/* ── welcome ── */
.odysseus-root .od-welcome { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center;
  gap:8px; color:var(--fg); }
.odysseus-root .od-welcome-title { display:flex; align-items:center; gap:10px; font-size:1.6rem; font-weight:600;
  color:var(--brand-color, var(--red)); }
.odysseus-root .od-welcome-sub { font-size:.9rem; opacity:.55; }

@keyframes od-msg-enter { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }

/* density */
.odysseus-root.od-density-compact { font-size:13px; }
.odysseus-root.od-density-compact .od-msg { padding:6px 10px; }
.odysseus-root.od-density-spacious { font-size:16px; }
.odysseus-root.od-density-spacious .od-msg { padding:14px 18px; }

/* bg patterns (odysseus static/style.css .bg-pattern-dots; canvas patterns
   perlin/petals/sparkles/synapse are a later effects port) */
.odysseus-root.od-bg-dots { background-image: radial-gradient(color-mix(in srgb, var(--fg) 5%, transparent) 1px, transparent 1px);
  background-size:20px 20px; }
.odysseus-root .od-bg-canvas { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; z-index:-1; }

/* ── search palette (Ctrl+K) ── */
.odysseus-root .od-search-overlay { position:absolute; inset:0; z-index:50; display:flex;
  align-items:flex-start; justify-content:center; padding-top:12vh; background:rgba(0,0,0,.45); }
.odysseus-root .od-search-backdrop { position:absolute; inset:0; z-index:0; background:none; border:none;
  padding:0; margin:0; cursor:default; }
.odysseus-root .od-search-panel { position:relative; z-index:1; width:560px; max-width:90%; background:var(--panel);
  border:1px solid var(--border); border-radius:12px; box-shadow:0 12px 40px rgba(0,0,0,.4); overflow:hidden; }
.odysseus-root .od-search-input { width:100%; padding:14px 16px; background:transparent; border:none;
  border-bottom:1px solid var(--border); color:var(--fg); font-size:15px; outline:none; box-sizing:border-box; }
.odysseus-root .od-search-input::placeholder { color:color-mix(in srgb, var(--fg) 35%, transparent); }
.odysseus-root .od-search-list { max-height:50vh; overflow-y:auto; }
.odysseus-root .od-search-item { display:flex; align-items:center; gap:8px; padding:10px 16px; width:100%;
  background:none; border:none; cursor:pointer; color:var(--fg); font-size:13px; text-align:left; }
.odysseus-root .od-search-item:hover { background:color-mix(in srgb, var(--red) 10%, transparent); }
.odysseus-root .od-search-empty { padding:16px; color:color-mix(in srgb, var(--fg) 45%, transparent);
  font-size:13px; text-align:center; }

/* ── memory panel ── */
.odysseus-root .od-mem-head { display:flex; align-items:baseline; justify-content:space-between; gap:8px;
  padding:13px 16px 6px; }
.odysseus-root .od-mem-title { font-size:14px; font-weight:600; color:var(--fg); }
.odysseus-root .od-mem-stats { font-size:11px; color:color-mix(in srgb, var(--fg) 55%, transparent); }
.odysseus-root .od-mem-item { display:flex; align-items:baseline; gap:10px; padding:8px 16px;
  border-top:1px solid color-mix(in srgb, var(--fg) 6%, transparent); }
.odysseus-root .od-mem-type { font-size:9px; text-transform:uppercase; letter-spacing:.04em; color:var(--red);
  flex-shrink:0; min-width:54px; }
.odysseus-root .od-mem-text { flex:1; font-size:13px; color:var(--fg); overflow:hidden; text-overflow:ellipsis;
  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
.odysseus-root .od-mem-time { font-size:10px; color:color-mix(in srgb, var(--fg) 45%, transparent); flex-shrink:0; }

/* ── skills panel ── */
.odysseus-root .od-skill-item { display:flex; align-items:center; gap:10px; padding:9px 16px;
  border-top:1px solid color-mix(in srgb, var(--fg) 6%, transparent); }
.odysseus-root .od-skill-info { flex:1; min-width:0; }
.odysseus-root .od-skill-name { font-size:13px; font-weight:500; color:var(--fg); display:flex; align-items:center; gap:6px; }
.odysseus-root .od-skill-desc { font-size:11px; color:color-mix(in srgb, var(--fg) 55%, transparent);
  overflow:hidden; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:1; -webkit-box-orient:vertical; }
.odysseus-root .od-skill-scan { font-size:8px; text-transform:uppercase; padding:1px 5px; border-radius:4px;
  background:color-mix(in srgb, var(--warn) 20%, transparent); color:var(--warn); flex-shrink:0; }
.odysseus-root .od-skill-toggle { flex-shrink:0; padding:4px 10px; border:1px solid var(--border); border-radius:12px;
  background:none; color:color-mix(in srgb, var(--fg) 50%, transparent); font-size:10px; cursor:pointer; min-width:38px; }
.odysseus-root .od-skill-toggle.on { border-color:var(--ok); color:var(--ok); background:color-mix(in srgb, var(--ok) 12%, transparent); }
.odysseus-root .od-set-section { font-size:10px; text-transform:uppercase; letter-spacing:.04em; opacity:.5;
  padding:11px 16px 4px; position:sticky; top:0; background:var(--panel); z-index:1; }

/* ── notes panel ── */
.odysseus-root .od-note-add { padding:4px 16px 8px; }
.odysseus-root .od-note-add .od-search-input { border:1px solid var(--border); border-radius:8px; }
.odysseus-root .od-note-item { display:flex; align-items:flex-start; gap:10px; padding:9px 16px;
  border-top:1px solid color-mix(in srgb, var(--fg) 6%, transparent); }
.odysseus-root .od-note-body { flex:1; min-width:0; }
.odysseus-root .od-note-text { font-size:13px; color:var(--fg); white-space:pre-wrap; word-break:break-word; }
.odysseus-root .od-note-time { font-size:10px; color:color-mix(in srgb, var(--fg) 45%, transparent); margin-top:3px; }
.odysseus-root .od-note-del { flex-shrink:0; background:none; border:none; cursor:pointer; font-size:12px;
  padding:2px 6px; border-radius:4px; color:color-mix(in srgb, var(--fg) 40%, transparent); }
.odysseus-root .od-note-del:hover { color:var(--red); background:color-mix(in srgb, var(--red) 10%, transparent); }


/* ===== CompareView ===== */

/* ── Compare arena (odysseus static/js/compare/* + style.css compare rules) ── */
/* Full-bleed arena reusing the .od-search-overlay backdrop pattern. The panel
   is a large column: header bar, pane grid, vote bar, composer. */
.odysseus-root .od-compare-panel {
  width: min(1180px, 96vw);
  height: min(86vh, 880px);
  max-width: none;
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
  animation: od-compare-enter 0.3s ease-out;
}
@keyframes od-compare-enter {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

/* Header bar — compare/index.js step 8 (.compare-header-bar) */
.odysseus-root .od-compare-header-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border);
}
.odysseus-root .od-compare-header-left {
  display: flex;
  align-items: center;
  min-width: 0;
}
.odysseus-root .od-compare-header-icon {
  display: inline-flex;
  flex-shrink: 0;
  margin-right: 6px;
  opacity: 0.85;
  color: var(--fg);
}
.odysseus-root .od-compare-header-label {
  font-size: 10px;
  font-weight: 400;
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.odysseus-root .od-compare-header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}
.odysseus-root .od-compare-hbtn {
  background: none;
  border: 1px solid var(--border);
  color: var(--fg);
  cursor: pointer;
  padding: 3px 10px;
  font-size: 11px;
  font-weight: 600;
  opacity: 0.7;
  transition: all 0.15s;
  line-height: 1;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-family: inherit;
}
.odysseus-root .od-compare-hbtn:hover { opacity: 1; border-color: var(--fg); }
.odysseus-root .od-compare-hbtn.on {
  opacity: 1;
  border-color: var(--fg);
  background: color-mix(in srgb, var(--fg) 10%, transparent);
}
.odysseus-root .od-compare-close-btn { padding: 3px 8px; }

/* Export dropdown — compare/index.js _toggleExportMenu (.compare-export-menu) */
.odysseus-root .od-compare-export-wrap {
  position: relative;
  display: inline-flex;
}
.odysseus-root .od-compare-export-menu {
  position: absolute;
  z-index: 10001;
  top: calc(100% + 4px);
  left: 0;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  padding: 4px;
  font-size: 12px;
  display: flex;
  flex-direction: column;
  min-width: 170px;
}
.odysseus-root .od-compare-export-item {
  background: none;
  border: none;
  color: var(--fg);
  text-align: left;
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
.odysseus-root .od-compare-export-item:hover {
  background: color-mix(in srgb, var(--fg) 8%, transparent);
}

/* Grid of panes — style.css .compare-grid */
.odysseus-root .od-compare-grid {
  display: grid;
  gap: 4px;
  flex: 1 1 0;
  min-height: 0;
  overflow: hidden;
  grid-auto-rows: 1fr;
  padding: 4px;
}
.odysseus-root .od-compare-grid[data-cols="1"] { grid-template-columns: 1fr; }
.odysseus-root .od-compare-grid[data-cols="2"] { grid-template-columns: 1fr 1fr; }
.odysseus-root .od-compare-grid[data-cols="3"] { grid-template-columns: 1fr 1fr 1fr; }
.odysseus-root .od-compare-grid[data-cols="4"] { grid-template-columns: repeat(4, 1fr); }

/* Pane — style.css .compare-pane */
.odysseus-root .od-compare-pane {
  position: relative;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  min-height: 0;
  min-width: 0;
}
.odysseus-root .od-pane-header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: color-mix(in srgb, var(--fg) 4%, transparent);
  border-bottom: 1px solid var(--border);
  font-size: 0.82em;
  font-weight: 600;
  color: var(--fg);
  transition: background 0.4s;
  flex-shrink: 0;
  overflow: hidden;
  min-width: 0;
  flex-wrap: wrap;
}
/* pane title as clickable model-swap button — style.css .pane-title-btn */
.odysseus-root .od-pane-title-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 10px;
  font-weight: 400;
  font-family: inherit;
  color: var(--fg);
  padding: 0;
  text-align: left;
  display: flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: opacity 0.15s;
  min-width: 0;
  flex: 1 1 0;
}
.odysseus-root .od-pane-title-btn:hover { opacity: 0.7; }
.odysseus-root .od-pane-title-caret {
  font-size: 0.6em;
  opacity: 0.35;
  flex-shrink: 0;
  position: relative;
  top: 2px;
}
.odysseus-root .od-pane-title-btn:hover .od-pane-title-caret { opacity: 0.7; }
.odysseus-root .od-pane-timer {
  font-size: 10px;
  font-weight: 400;
  opacity: 0.45;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  padding-right: 4px;
}
.odysseus-root .od-pane-finish-badge {
  font-weight: 600;
  color: var(--red);
}
.odysseus-root .od-pane-actions {
  display: flex;
  gap: 4px;
  align-items: center;
  margin-left: auto;
  flex-shrink: 0;
}
.odysseus-root .od-pane-action-btn {
  background: none;
  border: none;
  color: var(--fg);
  cursor: pointer;
  opacity: 0.3;
  padding: 2px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  transition: all 0.15s;
}
.odysseus-root .od-pane-action-btn:hover {
  opacity: 0.8;
  background: color-mix(in srgb, var(--fg) 6%, transparent);
}
.odysseus-root .od-pane-close-btn { opacity: 0.3; }
.odysseus-root .od-pane-close-btn:hover { opacity: 1; color: var(--red); }

/* Model swap dropdown — style.css .pane-model-dropdown / .pane-model-item */
.odysseus-root .od-pane-model-dropdown {
  position: absolute;
  z-index: 1000;
  top: 30px;
  left: 6px;
  min-width: 220px;
  max-width: calc(100% - 12px);
  max-height: 300px;
  overflow-y: auto;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  padding: 4px;
}
.odysseus-root .od-pane-prov-select {
  width: 100%;
  padding: 6px 8px;
  margin-bottom: 4px;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 0.78em;
  font-family: inherit;
}
.odysseus-root .od-pane-model-item {
  display: block;
  width: 100%;
  padding: 6px 10px;
  font-size: 0.7em;
  text-align: left;
  background: none;
  border: none;
  border-radius: 4px;
  color: var(--fg);
  cursor: pointer;
  transition: background 0.1s;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.odysseus-root .od-pane-model-item:hover {
  background: color-mix(in srgb, var(--fg) 10%, transparent);
}
.odysseus-root .od-pane-model-item.current { color: var(--red); font-weight: 600; }
.odysseus-root .od-pane-model-empty {
  padding: 10px;
  text-align: center;
  font-size: 11px;
  opacity: 0.5;
}

/* Pane chat-history scroller — style.css .compare-pane .chat-history */
.odysseus-root .od-pane-history {
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 8px;
  display: flex;
  flex-direction: column;
}
.odysseus-root .od-pane-ready {
  margin: auto;
  padding: 16px;
  text-align: center;
  font-size: 0.82em;
  font-style: italic;
  color: color-mix(in srgb, var(--fg) 45%, transparent);
}

/* Per-pane vote footer — style.css .pane-vote-footer / .pane-vote-btn */
.odysseus-root .od-pane-vote-footer {
  padding: 6px 8px;
  border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  background: color-mix(in srgb, var(--fg) 3%, transparent);
  flex-shrink: 0;
}
.odysseus-root .od-pane-vote-btn {
  width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 10px;
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, opacity 0.15s;
}
.odysseus-root .od-pane-vote-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent, var(--fg)) 12%, var(--bg));
  border-color: var(--accent, var(--fg));
}
.odysseus-root .od-pane-vote-btn:disabled { cursor: not-allowed; opacity: 0.4; }
.odysseus-root .od-pane-vote-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

/* Vote bar — style.css .compare-vote-bar / .compare-vote-btn */
.odysseus-root .od-compare-vote-bar {
  display: flex;
  justify-content: center;
  gap: 8px;
  padding: 8px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
  flex-wrap: wrap;
}
.odysseus-root .od-compare-vote-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 13px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--fg);
  cursor: pointer;
  font-size: 0.8em;
  font-family: inherit;
  transition: all 0.15s;
  white-space: nowrap;
}
.odysseus-root .od-compare-vote-btn:hover:not(:disabled) {
  border-color: var(--red);
  background: color-mix(in srgb, var(--red) 11%, transparent);
}
.odysseus-root .od-compare-vote-btn:disabled { cursor: not-allowed; opacity: 0.25; }
.odysseus-root .od-compare-vote-tie { opacity: 0.7; }
.odysseus-root .od-compare-rematch-btn {
  margin-left: 8px;
  border-color: color-mix(in srgb, var(--fg) 20%, transparent);
  opacity: 0.6;
}
.odysseus-root .od-compare-rematch-btn:hover { opacity: 1; }

/* Composer + eval picker — style.css .chat-input-bar / .cmp-eval-* */
.odysseus-root .od-compare-input-bar {
  position: relative;
  padding: 8px 10px 10px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}
.odysseus-root .od-cmp-input-top {
  position: relative;
  height: 0;
}
.odysseus-root .od-cmp-eval-wrap {
  position: absolute;
  top: 0;
  right: 0;
  z-index: 2;
}
.odysseus-root .od-cmp-eval-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--fg);
  font-size: 11px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  opacity: 0.75;
  transition: opacity 0.15s, border-color 0.15s;
}
.odysseus-root .od-cmp-eval-btn:hover { opacity: 1; border-color: var(--fg); }
.odysseus-root .od-cmp-eval-caret { opacity: 0.7; transform: rotate(180deg); }
.odysseus-root .od-cmp-eval-menu {
  position: absolute;
  bottom: calc(100% + 4px);
  right: 0;
  min-width: 220px;
  max-width: 280px;
  max-height: 360px;
  overflow-y: auto;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.3);
  padding: 4px;
  z-index: 1000;
}
.odysseus-root .od-cmp-eval-group-label {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  opacity: 0.45;
  font-weight: 600;
  padding: 6px 8px 2px;
}
.odysseus-root .od-cmp-eval-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 5px 8px;
  background: none;
  border: none;
  color: var(--fg);
  font-size: 11px;
  font-family: inherit;
  border-radius: 4px;
  cursor: pointer;
}
.odysseus-root .od-cmp-eval-item:hover {
  background: color-mix(in srgb, var(--fg) 8%, transparent);
}
.odysseus-root .od-cmp-eval-item-tick {
  float: right;
  margin-left: 6px;
  font-size: 10px;
  color: var(--ok);
  opacity: 0.8;
}
/* Expected-answer chip — style.css .cmp-eval-expected */
.odysseus-root .od-cmp-eval-expected {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 10px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 11px;
  background: var(--panel);
  border: 1px solid color-mix(in srgb, var(--ok) 50%, transparent);
  border-radius: 8px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4), 0 1px 2px rgba(0, 0, 0, 0.2);
  color: var(--fg);
  width: fit-content;
  z-index: 5;
}
.odysseus-root .od-cmp-eval-expected-label {
  opacity: 0.6;
  text-transform: uppercase;
  font-size: 9px;
  letter-spacing: 0.5px;
  font-weight: 600;
}
.odysseus-root .od-cmp-eval-expected-value {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
}
.odysseus-root .od-cmp-eval-expected-close {
  background: none;
  border: none;
  color: var(--fg);
  font-size: 14px;
  line-height: 1;
  padding: 0 0 0 4px;
  opacity: 0.5;
  cursor: pointer;
  font-family: inherit;
}
.odysseus-root .od-cmp-eval-expected-close:hover { opacity: 1; }
.odysseus-root .od-compare-input {
  width: 100%;
  min-height: 52px;
  resize: none;
  box-sizing: border-box;
  padding: 10px 12px;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-family: inherit;
  font-size: 0.9em;
  line-height: 1.4;
}
.odysseus-root .od-compare-input:focus {
  outline: none;
  border-color: var(--accent, var(--fg));
}

/* Scoreboard overlay — scoreboard.js + style.css .scoreboard-table */
.odysseus-root .od-compare-scoreboard-overlay {
  position: fixed;
  inset: 0;
  z-index: 10001;
  display: flex;
  align-items: center;
  justify-content: center;
}
.odysseus-root .od-compare-scoreboard {
  position: relative;
  z-index: 1;
  width: min(520px, 92vw);
  max-height: 80vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.45);
}
.odysseus-root .od-scoreboard-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88em;
}
.odysseus-root .od-scoreboard-table th {
  text-align: center;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  font-weight: 600;
  font-size: 0.85em;
  color: color-mix(in srgb, var(--fg) 55%, transparent);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.odysseus-root .od-scoreboard-table th:first-child { text-align: left; }
.odysseus-root .od-scoreboard-table td {
  padding: 5px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 40%, transparent);
  text-align: center;
}
.odysseus-root .od-scoreboard-table td.od-scoreboard-model {
  text-align: left;
  font-weight: 500;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.odysseus-root .od-scoreboard-table td.od-scoreboard-pct {
  font-weight: 600;
  color: var(--red);
}
.odysseus-root .od-scoreboard-table tbody tr:hover {
  background: color-mix(in srgb, var(--fg) 5%, transparent);
}
.odysseus-root .od-scoreboard-clear-btn {
  align-self: flex-end;
  padding: 4px 12px;
  background: none;
  border: 1px solid var(--border);
  color: var(--fg);
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
  font-family: inherit;
  opacity: 0.6;
  transition: opacity 0.15s;
}
.odysseus-root .od-scoreboard-clear-btn:hover { opacity: 1; }

/* ===== ResearchView ===== */

/* ── Deep Research panel (odysseus static/js/research/* + .research-*/.rs-* in style.css), 1:1.
   Colors mapped onto the eliza theme vars: --accent-primary→--accent, --fg-dim/--fg-muted→--muted,
   --color-success→--ok. The odysseus source already used var(--accent, var(--red)) fallbacks. */

/* Pane: override the shared .od-search-panel sizing to odysseus's centered ~640px / 85vh modal. */
.odysseus-root .od-search-panel.research-pane {
  width: min(640px, 92vw); max-width: 92vw; max-height: 85vh;
  display: flex; flex-direction: column;
  padding: 10px; box-sizing: border-box;
  font-size: 12px; letter-spacing: -0.015em;
  position: relative; isolation: isolate; overflow: hidden;
  background: var(--bg);
}
.odysseus-root .research-pane-header {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 6px; user-select: none;
}
.odysseus-root .research-pane-header h4 {
  margin: 0; display: flex; align-items: center; gap: 6px;
  font-size: 1rem; font-weight: 600; letter-spacing: -0.03em; color: var(--red);
}
.odysseus-root .research-pane-header-actions { display: flex; align-items: center; gap: 2px; margin-left: auto; }
.odysseus-root .research-pane-close {
  background: transparent; border: none; color: var(--fg); opacity: 0.55;
  cursor: pointer; padding: 2px; display: flex; transition: opacity 0.15s;
}
.odysseus-root .research-pane-close:hover { opacity: 1; }
.odysseus-root .research-pane-body {
  flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column;
  padding: 0; margin: 0; background: transparent; border: 0; border-radius: 0;
  font-size: 12px; color: var(--fg);
}

/* New-job compose card (.research-new-job → admin-card surface). */
.odysseus-root .research-new-job {
  padding: 12px; margin-bottom: 10px; background: var(--panel);
  border: 1px solid var(--border); border-radius: 8px; flex-shrink: 0;
}
.odysseus-root .research-new-job-title { display: flex; align-items: baseline; gap: 8px; margin-bottom: 2px; }
.odysseus-root .research-new-job h2 { margin: 0; padding: 0; line-height: 1; font-size: 14px; font-weight: 600; letter-spacing: -0.03em; }
.odysseus-root .research-stats { font-size: 0.6em; opacity: 0.6; font-weight: normal; }
.odysseus-root .memory-count { font-variant-numeric: tabular-nums; }
.odysseus-root .memory-desc { font-size: 12px; opacity: 0.7; }
.odysseus-root .research-desc { margin-top: 6px; display: flex; align-items: center; gap: 6px; }
.odysseus-root .research-desc svg { flex-shrink: 0; opacity: 0.8; }
.odysseus-root .research-query {
  width: 100%; resize: vertical; min-height: 80px; max-height: 240px;
  background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 6px;
  padding: 8px 10px; font-size: 12px; font-family: inherit; box-sizing: border-box; margin-top: 6px;
}
.odysseus-root .research-query:focus { outline: none; border-color: var(--accent, var(--red)); }

/* Category chips (.research-cat → doclib-chip). */
.odysseus-root .research-category-row { display: flex; gap: 4px; margin-top: 8px; flex-wrap: wrap; }
.odysseus-root .research-cat {
  padding: 2px 10px; border-radius: 12px; font-size: 10px;
  border: 1px solid var(--border); background: transparent; color: var(--muted);
  cursor: pointer; user-select: none;
  transition: background 0.15s, border-color 0.15s, color 0.15s; position: relative; top: -4px;
}
.odysseus-root .research-cat:hover { border-color: var(--red); }
.odysseus-root .research-cat.active {
  background: color-mix(in srgb, var(--red) 15%, transparent);
  border-color: color-mix(in srgb, var(--red) 40%, transparent); color: var(--red);
}

/* Settings toggle + body. */
.odysseus-root .research-settings-toggle {
  display: flex; align-items: center; gap: 6px; width: 100%; text-align: left;
  height: 26px; padding: 0 8px; margin-top: 23px;
  background: none; border: 1px solid var(--border); border-radius: 4px;
  color: color-mix(in srgb, var(--fg) 60%, transparent);
  font-size: 11px; font-family: inherit; cursor: pointer; transition: all 0.15s;
}
.odysseus-root .research-settings-toggle:hover { color: var(--fg); border-color: var(--fg); }
.odysseus-root .research-settings-chevron { display: inline-flex; transition: transform 0.2s; margin-left: auto; }
.odysseus-root .research-settings-toggle.collapsed .research-settings-chevron { transform: rotate(-90deg); }
.odysseus-root .research-settings-row {
  display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; padding: 8px 10px;
  background: color-mix(in srgb, var(--fg) 3%, transparent);
  border: 1px solid var(--border); border-radius: 6px;
}
.odysseus-root .research-setting { display: flex; flex-direction: column; flex: 1; min-width: 90px; }
.odysseus-root .research-setting-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.5; margin-bottom: 2px; }
.odysseus-root .research-setting select {
  font-size: 11px; padding: 4px 6px; background: var(--bg); color: var(--fg);
  border: 1px solid var(--border); border-radius: 4px;
}

/* Controls row (Queue / Start). */
.odysseus-root .research-controls-row { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
.odysseus-root .research-add-btn {
  padding: 6px 14px; border: 1px solid var(--border); border-radius: 6px;
  background: transparent; color: var(--fg); font-size: 12px; cursor: pointer; transition: background 0.15s;
}
.odysseus-root .research-add-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--border) 30%, transparent); }
.odysseus-root .research-start-btn {
  margin-left: auto; display: flex; align-items: center; gap: 5px;
  padding: 6px 16px; border: none; border-radius: 6px;
  background: var(--accent, var(--red)); color: #fff; font-size: 12px; font-weight: 600;
  cursor: pointer; transition: opacity 0.15s;
}
.odysseus-root .research-start-btn:hover:not(:disabled) { opacity: 0.85; }
.odysseus-root .research-add-btn:disabled, .odysseus-root .research-start-btn:disabled { opacity: 0.6; cursor: not-allowed; }

/* Jobs list. */
.odysseus-root .research-jobs-list {
  flex: 1; min-height: 0; overflow-y: auto; padding: 6px 0;
  display: flex; flex-direction: column; gap: 6px;
}
.odysseus-root .research-empty { text-align: center; padding: 30px 14px; font-size: 12px; opacity: 0.4; }

/* Foldable sections (Active / Past research). */
.odysseus-root .research-section {
  margin-top: 6px; background: var(--panel); border: 1px solid var(--border);
  border-radius: 8px; overflow: hidden;
}
.odysseus-root .research-section-header {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 10px 12px; user-select: none; transition: background 0.15s;
}
.odysseus-root .research-section:not(.collapsed) > .research-section-header { border-bottom: 1px solid var(--border); }
.odysseus-root .research-section-header:hover { background: color-mix(in srgb, var(--fg) 4%, transparent); }
.odysseus-root .research-section-toggle {
  display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;
  background: none; border: none; color: inherit; cursor: pointer; text-align: left; padding: 0; font: inherit;
}
.odysseus-root .research-section-title { font-size: 14px; font-weight: 600; letter-spacing: -0.03em; }
.odysseus-root .research-section-count { font-size: 10px; opacity: 0.6; font-weight: normal; font-variant-numeric: tabular-nums; }
.odysseus-root .research-section-right { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.odysseus-root .research-section-clear {
  display: inline-flex; align-items: center; gap: 4px;
  background: none; border: 1px solid transparent; color: var(--muted);
  font-size: 10px; font-family: inherit; cursor: pointer; padding: 2px 6px; border-radius: 4px;
  opacity: 0.6; transition: all 0.15s;
}
.odysseus-root .research-section-clear:hover { opacity: 1; color: var(--fg); border-color: var(--border); }
.odysseus-root .research-section-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; opacity: 0.9; }
.odysseus-root .research-section-dot.pulsing { animation: research-dot-pulse 1.5s ease-in-out infinite; }
@keyframes research-dot-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent, var(--red)) 55%, transparent); }
  70%      { box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent, var(--red)) 0%, transparent); }
}
.odysseus-root .research-section-chevron { flex-shrink: 0; opacity: 0.55; transition: transform 0.2s ease; }
.odysseus-root .research-section.collapsed .research-section-chevron { transform: rotate(-90deg); }
.odysseus-root .research-section-body { display: flex; flex-direction: column; gap: 8px; padding: 12px; }
.odysseus-root .research-section.collapsed .research-section-body { display: none; }
.odysseus-root .research-library-hint { padding: 0 12px 4px; font-size: 11px; opacity: 0.7; }

/* Job cards (.research-job-card → doclib-card). */
.odysseus-root .research-job-card {
  margin: 0; padding: 8px 10px; background: color-mix(in srgb, var(--fg) 3%, transparent);
  border: 1px solid var(--border); border-radius: 8px; transition: background 0.15s, border-color 0.15s;
}
.odysseus-root .research-job-card:hover {
  background: color-mix(in srgb, var(--fg) 5%, transparent);
  border-color: color-mix(in srgb, var(--fg) 16%, transparent);
}
.odysseus-root .research-job-card.running { border-left: 3px solid var(--accent, var(--red)); }
.odysseus-root .research-job-card.queued { border-left: 3px solid var(--muted); }
.odysseus-root .research-job-card.done { border-left: 1px solid var(--border); }
.odysseus-root .research-job-card.done.from-library { opacity: 1; }
.odysseus-root .research-job-card.error, .odysseus-root .research-job-card.cancelled { border-left: 3px solid var(--red); }
.odysseus-root .research-job-card[data-category] { --cat-color: var(--accent, var(--red)); }
.odysseus-root .research-job-card[data-category="product"]    { --cat-color: #5b8abf; }
.odysseus-root .research-job-card[data-category="comparison"] { --cat-color: #e5a33a; }
.odysseus-root .research-job-card[data-category="howto"]      { --cat-color: #82c882; }
.odysseus-root .research-job-card[data-category="landscape"]  { --cat-color: #a07ae0; }
.odysseus-root .research-job-card[data-category="factcheck"]  { --cat-color: var(--red); }
.odysseus-root .research-job-card.done[data-category] { background: color-mix(in srgb, var(--cat-color) 4%, transparent); }
.odysseus-root .research-job-card.done[data-category]:hover { background: color-mix(in srgb, var(--cat-color) 7%, transparent); }

/* Job header + meta. */
.odysseus-root .research-job-header { display: flex; align-items: center; gap: 8px; }
.odysseus-root .research-job-header-btn {
  display: block; width: 100%; background: none; border: none; padding: 0;
  font: inherit; color: inherit; cursor: pointer; text-align: left;
}
.odysseus-root .research-job-card.running .research-job-query,
.odysseus-root .research-job-card.running .research-cat-badge,
.odysseus-root .research-job-card.running .research-job-model,
.odysseus-root .research-job-card.running .research-job-time { position: relative; top: -4px; }
.odysseus-root .research-job-query {
  flex: 1; font-size: 11px; font-weight: 600; letter-spacing: -0.01em;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg);
}
.odysseus-root .research-job-time, .odysseus-root .research-job-meta { font-size: 10px; opacity: 0.5; white-space: nowrap; font-family: monospace; }
.odysseus-root .research-job-status { font-size: 10px; text-transform: uppercase; opacity: 0.6; }
.odysseus-root .research-job-model { font-size: 9px; opacity: 0.4; white-space: nowrap; max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
.odysseus-root .research-job-cancel { background: transparent; border: none; color: var(--fg); opacity: 0.4; cursor: pointer; padding: 2px; display: flex; transition: opacity 0.15s; }
.odysseus-root .research-job-cancel:hover { opacity: 1; }
.odysseus-root .research-job-phase { font-size: 11px; opacity: 0.6; margin-top: 4px; }
.odysseus-root .research-job-queued-meta { font-size: 10px; opacity: 0.4; margin-top: 2px; }
.odysseus-root .research-job-error { font-size: 11px; color: var(--red); margin-top: 4px; line-height: 1.4; word-break: break-word; }

/* Category badge. */
.odysseus-root .research-cat-badge {
  font-size: 10px; font-weight: 500; text-transform: lowercase; letter-spacing: 0;
  padding: 0; background: transparent; border: 0; border-radius: 0;
  color: var(--cat-color, var(--accent)); opacity: 0.55; flex-shrink: 0; margin-left: 2px;
  position: relative; top: -1px; display: inline-flex; align-items: center; gap: 3px;
}
.odysseus-root .research-cat-badge.research-cat-standard { color: var(--ok); opacity: 0.75; }
.odysseus-root .research-cat-badge.research-cat-failed { color: var(--red); opacity: 0.8; }

/* Action buttons (.research-job-action → doclib-toolbar-btn). */
.odysseus-root .research-job-actions { display: flex; gap: 4px; margin-top: 6px; }
.odysseus-root .research-job-actions .research-job-action:not(.research-job-action-dim) + .research-job-action-dim { margin-left: auto; }
.odysseus-root .research-job-actions > .research-job-action-dim:first-child { margin-left: auto; }
.odysseus-root .research-job-action {
  display: inline-flex; align-items: center; gap: 4px; padding: 5px 10px;
  background: none; border: 1px solid var(--border); border-radius: 6px;
  color: var(--muted); font-size: 11px; font-family: inherit; white-space: nowrap;
  cursor: pointer; transition: all 0.15s;
}
.odysseus-root .research-job-action:hover:not(:disabled) { color: var(--fg); border-color: var(--fg); }
.odysseus-root .research-job-action:disabled { opacity: 0.45; cursor: not-allowed; }
.odysseus-root .research-job-action-dim { opacity: 0.5; border-color: transparent; }
.odysseus-root .research-job-action-dim:hover:not(:disabled) { opacity: 1; }

/* Progress bar. */
.odysseus-root .research-progress-bar { height: 3px; background: var(--border); border-radius: 2px; margin-top: 6px; overflow: hidden; }
.odysseus-root .research-progress-fill { height: 100%; background: var(--accent, var(--red)); border-radius: 2px; transition: width 0.4s ease; }

/* Result / report. */
.odysseus-root .research-job-result { margin-top: 10px; border-top: 1px solid var(--border); padding-top: 10px; }
.odysseus-root .research-job-sources { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
.odysseus-root .research-source-link {
  font-size: 10px; padding: 2px 6px; background: color-mix(in srgb, var(--accent, var(--red)) 10%, transparent);
  border-radius: 3px; color: var(--accent, var(--red)); text-decoration: none; white-space: nowrap;
  max-width: 200px; overflow: hidden; text-overflow: ellipsis;
}
.odysseus-root .research-source-link:hover { text-decoration: underline; }
.odysseus-root .research-source-more { font-size: 10px; opacity: 0.5; padding: 2px 4px; }
.odysseus-root .research-job-report-body { font-size: 12px; line-height: 1.55; max-height: 400px; overflow-y: auto; }
.odysseus-root .research-job-report-body h1,
.odysseus-root .research-job-report-body h2,
.odysseus-root .research-job-report-body h3 { font-size: 13px; margin: 12px 0 4px; color: var(--cat-color, var(--accent, var(--fg))); }
.odysseus-root .research-job-report-body p { margin: 4px 0; }
.odysseus-root .research-job-report-body ul { margin: 4px 0; }

/* Category hero banner. */
.odysseus-root .research-hero {
  display: flex; align-items: center; gap: 14px; padding: 16px 18px; margin: 8px 0 14px;
  border-radius: 10px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--cat-color, var(--accent)) 18%, transparent) 0%, color-mix(in srgb, var(--cat-color, var(--accent)) 5%, transparent) 100%);
  border-left: 4px solid var(--cat-color, var(--accent)); position: relative; overflow: hidden;
}
.odysseus-root .research-hero::after {
  content: ''; position: absolute; right: -40px; top: -40px; width: 160px; height: 160px; border-radius: 50%;
  background: radial-gradient(circle, color-mix(in srgb, var(--cat-color, var(--accent)) 15%, transparent) 0%, transparent 60%); pointer-events: none;
}
.odysseus-root .research-hero-icon {
  flex-shrink: 0; width: 32px; height: 32px; color: var(--cat-color, var(--accent));
  display: flex; align-items: center; justify-content: center;
  filter: drop-shadow(0 2px 4px color-mix(in srgb, var(--cat-color, var(--accent)) 40%, transparent));
}
.odysseus-root .research-hero-text { flex: 1; min-width: 0; }
.odysseus-root .research-hero-label { font-size: 10px; text-transform: uppercase; letter-spacing: 1.2px; font-weight: 700; opacity: 0.7; margin-bottom: 3px; color: var(--cat-color, var(--accent)); }
.odysseus-root .research-hero-query { font-size: 15px; font-weight: 600; line-height: 1.3; color: var(--fg); }

/* Per-category report body theming. */
.odysseus-root .research-body-product ul { list-style: none; padding-left: 0; }
.odysseus-root .research-body-product ul li {
  padding: 6px 10px 6px 28px; margin: 4px 0;
  border-left: 2px solid color-mix(in srgb, #5b8abf 40%, transparent);
  background: color-mix(in srgb, #5b8abf 4%, transparent); border-radius: 0 4px 4px 0; position: relative;
}
.odysseus-root .research-body-product ul li::before { content: '▸'; position: absolute; left: 10px; color: #5b8abf; font-weight: bold; }
.odysseus-root .research-body-howto ol { counter-reset: howto-step; list-style: none; padding-left: 0; }
.odysseus-root .research-body-howto ol > li {
  counter-increment: howto-step; position: relative; padding: 10px 12px 10px 52px; margin: 8px 0;
  background: color-mix(in srgb, #82c882 5%, transparent); border-radius: 8px; border-left: 2px solid #82c882;
}
.odysseus-root .research-body-howto ol > li::before {
  content: counter(howto-step); position: absolute; left: 10px; top: 14px;
  width: 30px; height: 30px; border-radius: 50%; background: #82c882; color: #fff;
  font-weight: 700; font-size: 13px; display: flex; align-items: center; justify-content: center;
  box-shadow: 0 2px 6px color-mix(in srgb, #82c882 40%, transparent);
}
.odysseus-root .research-body-factcheck strong {
  color: var(--red); padding: 1px 6px; border-radius: 4px; background: color-mix(in srgb, var(--red) 12%, transparent);
}

/* ── Synapse graph (researchSynapse.js + .research-synapse / .rs-* in style.css). ── */
.odysseus-root .research-synapse {
  margin: 6px 0 4px; border: 1px solid var(--border); border-radius: 10px;
  background:
    radial-gradient(ellipse at center, color-mix(in srgb, var(--accent, var(--red)) 10%, transparent) 0%, transparent 70%),
    color-mix(in srgb, var(--panel) 50%, var(--bg));
  overflow: hidden;
}
.odysseus-root .research-synapse .rs-stage { height: 200px; position: relative; }
.odysseus-root .research-synapse-compact .rs-stage { height: 130px; }
.odysseus-root .research-synapse-compact .rs-meta { padding: 4px 8px 5px; font-size: 10px; }
.odysseus-root .research-synapse-compact .rs-label-sub { font-size: 8px; }
.odysseus-root .research-synapse svg { display: block; width: 100%; height: 100%; }
.odysseus-root .research-synapse .rs-edge { stroke: var(--border); stroke-width: 1.2; fill: none; opacity: 0.55; }
.odysseus-root .research-synapse .rs-node {
  fill: var(--bg); stroke: var(--accent, var(--red)); stroke-width: 1.5;
  transition: all 0.3s ease; transform-box: fill-box; transform-origin: center;
}
.odysseus-root .research-synapse .rs-node-root { fill: var(--accent, var(--red)); stroke: var(--accent, var(--red)); }
.odysseus-root .research-synapse .rs-node-sub { stroke: color-mix(in srgb, var(--accent, var(--red)) 70%, var(--fg)); }
.odysseus-root .research-synapse .rs-node-leaf {
  stroke: color-mix(in srgb, var(--accent, var(--red)) 55%, transparent);
  fill: color-mix(in srgb, var(--accent, var(--red)) 22%, var(--bg));
}
.odysseus-root .research-synapse .rs-pulse {
  fill: var(--accent, var(--red)); opacity: 0;
  animation: rs-pulse 2.6s ease-out infinite; transform-box: fill-box; transform-origin: center;
}
@keyframes rs-pulse {
  0%   { transform: scale(1); opacity: 0.65; }
  100% { transform: scale(5); opacity: 0; }
}
.odysseus-root .research-synapse .rs-label { fill: var(--fg); font-size: 10px; font-family: ui-monospace, "JetBrains Mono", monospace; pointer-events: none; opacity: 0.85; }
.odysseus-root .research-synapse .rs-label-sub { font-size: 9px; opacity: 0.7; }
.odysseus-root .research-synapse .rs-meta {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 6px 10px 8px;
  font-family: ui-monospace, "JetBrains Mono", monospace; font-size: 11px; color: var(--muted); opacity: 0.85;
  border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
}
.odysseus-root .research-synapse .rs-meta .rs-status { color: var(--accent, var(--red)); font-weight: 600; }
.odysseus-root .research-synapse .rs-meta b { color: var(--fg); font-weight: 600; }
.odysseus-root .research-synapse .rs-meta .rs-sep { opacity: 0.4; }
.odysseus-root .research-synapse.rs-complete .rs-pulse { animation: none; opacity: 0; }
.odysseus-root .research-synapse.rs-complete .rs-node-root { fill: var(--ok); stroke: var(--ok); }
.odysseus-root .research-synapse.rs-complete .rs-meta .rs-status { color: var(--ok); }
.odysseus-root .research-job-synapse-host.synapse-collapsed { display: none; }

@media (prefers-reduced-motion: reduce) {
  .odysseus-root .research-synapse .rs-pulse { animation: none; }
  .odysseus-root .research-section-dot.pulsing { animation: none; }
}

/* ===== DocumentLibraryView ===== */

/* ── document library (documentLibrary.js #doclib-modal Documents tab + rag.js) ── */
.odysseus-root .od-doclib-panel { width:640px; max-width:92%; display:flex; flex-direction:column; max-height:85vh; }
.odysseus-root .od-doclib-header { display:flex; align-items:center; gap:8px; padding:13px 16px 6px; }
.odysseus-root .od-doclib-title { font-size:14px; font-weight:600; letter-spacing:-0.03em; color:var(--fg); }
.odysseus-root .od-doclib-count { font-size:11px; color:color-mix(in srgb, var(--fg) 55%, transparent); }
.odysseus-root .od-doclib-toolbar-btn { background:none; border:1px solid var(--border);
  color:color-mix(in srgb, var(--fg) 60%, transparent); font-size:11px; height:24px; padding:0 8px; border-radius:6px;
  cursor:pointer; font-family:inherit; white-space:nowrap; display:inline-flex; align-items:center; gap:3px;
  transition:all .15s; }
.odysseus-root .od-doclib-toolbar-btn:hover { border-color:var(--fg); color:var(--fg); }
.odysseus-root .od-doclib-import { margin-left:auto; }
.odysseus-root .od-doclib-close { background:var(--bg); color:var(--fg); border:1px solid var(--fg); font-size:12px;
  width:24px; height:24px; padding:0; display:inline-flex; align-items:center; justify-content:center; line-height:1;
  cursor:pointer; border-radius:4px; flex-shrink:0; }
.odysseus-root .od-doclib-close:hover { background:var(--fg); color:var(--bg); }
.odysseus-root .od-doclib-file-input { display:none; }
.odysseus-root .od-doclib-desc { margin:0; padding:0 16px; font-size:11px; line-height:1.5;
  color:color-mix(in srgb, var(--fg) 50%, transparent); }
.odysseus-root .od-doclib-toolbar { display:flex; align-items:center; gap:8px; padding:8px 16px; }
.odysseus-root .od-doclib-filters { display:flex; gap:4px; flex-wrap:wrap; }
.odysseus-root .od-doclib-sort { background:var(--bg); color:var(--fg); border:1px solid var(--border);
  border-radius:6px; font-family:inherit; font-size:11px; height:24px; padding:0 6px; cursor:pointer; }
.odysseus-root .od-doclib-sort:focus { outline:none; border-color:var(--red); }
.odysseus-root .od-doclib-search { height:24px; padding:0 8px; border-radius:6px; border:1px solid var(--border);
  background:var(--bg); color:var(--fg); font-family:inherit; font-size:11px; flex:1; box-sizing:border-box; }
.odysseus-root .od-doclib-search:focus { outline:none; border-color:var(--red); }
.odysseus-root .od-doclib-search::placeholder { color:color-mix(in srgb, var(--fg) 40%, transparent); }
.odysseus-root .od-doclib-grid { display:flex; flex-direction:column; gap:4px; overflow-y:auto; padding:2px 16px;
  min-height:0; flex:1; }
.odysseus-root .od-doclib-empty { text-align:center; color:color-mix(in srgb, var(--fg) 35%, transparent);
  padding:32px 16px; font-size:12px; font-style:italic; }
.odysseus-root .od-doclib-card { display:flex; align-items:flex-start; gap:8px; flex-direction:row; flex-wrap:wrap;
  border:1px solid var(--border); border-radius:8px; background:color-mix(in srgb, var(--fg) 3%, transparent);
  cursor:pointer; position:relative; transition:all .15s; flex-shrink:0; }
.odysseus-root .od-doclib-card:hover { background:color-mix(in srgb, var(--fg) 5%, transparent);
  border-color:color-mix(in srgb, var(--fg) 16%, transparent); }
.odysseus-root .od-doclib-card-main { flex:1; min-width:0; display:flex; background:none; border:none; padding:8px 10px;
  cursor:pointer; text-align:left; color:inherit; font-family:inherit; }
.odysseus-root .od-doclib-content { flex:1; min-width:0; padding-top:4px; }
.odysseus-root .od-doclib-titlerow { display:flex; align-items:center; gap:6px; width:100%; }
.odysseus-root .od-doclib-item-title { font-size:12px; font-weight:500; overflow:hidden; text-overflow:ellipsis;
  white-space:nowrap; flex:0 1 auto; min-width:0; display:inline-flex; align-items:center; gap:4px; color:var(--fg); }
.odysseus-root .od-doclib-doc-icon { opacity:.55; flex-shrink:0; }
.odysseus-root .od-doclib-ver { font-size:9px; padding:1px 6px; border-radius:8px; flex-shrink:0; font-weight:600;
  letter-spacing:.3px; text-transform:lowercase;
  background:color-mix(in srgb, var(--red) 15%, transparent);
  border:1px solid color-mix(in srgb, var(--red) 40%, transparent); color:var(--red); }
.odysseus-root .od-doclib-ver-muted { background:color-mix(in srgb, var(--fg) 6%, transparent);
  border-color:color-mix(in srgb, var(--fg) 12%, transparent); color:color-mix(in srgb, var(--fg) 35%, transparent); }
.odysseus-root .od-doclib-chevron { margin-left:auto; align-self:center; opacity:.6; flex-shrink:0;
  transition:transform .15s ease; }
.odysseus-root .od-doclib-card-expanded .od-doclib-chevron { transform:rotate(180deg); }
.odysseus-root .od-doclib-meta { font-size:10px; opacity:.55; margin-top:2px; display:flex; align-items:center;
  gap:6px; flex-wrap:wrap; color:var(--fg); }
.odysseus-root .od-doclib-meta-sep { opacity:.5; }
.odysseus-root .od-doclib-actions { display:flex; gap:4px; flex-shrink:0; position:relative; padding:8px 8px 0 0; }
.odysseus-root .od-doclib-item-btn { background:none; border:1px solid transparent;
  color:color-mix(in srgb, var(--fg) 50%, transparent); height:22px; padding:0 6px; border-radius:6px; cursor:pointer;
  display:flex; align-items:center; opacity:0; transition:all .15s; }
.odysseus-root .od-doclib-card:hover .od-doclib-item-btn { opacity:1; }
.odysseus-root .od-doclib-item-btn:hover { color:var(--fg); border-color:var(--border);
  background:color-mix(in srgb, var(--fg) 6%, transparent); }
.odysseus-root .od-doclib-dropdown { position:absolute; top:100%; right:0; z-index:1000; width:max-content; padding:4px;
  background:var(--panel); border:1px solid var(--border); border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,.3);
  font-size:12px; }
.odysseus-root .od-doclib-dropdown-item { display:flex; align-items:center; gap:7px; width:100%; text-align:left;
  padding:6px 10px; border:none; background:none; color:var(--fg); font-size:12px; border-radius:4px; cursor:pointer;
  font-family:inherit; }
.odysseus-root .od-doclib-dropdown-item:hover { background:color-mix(in srgb, var(--fg) 8%, transparent); }
.odysseus-root .od-doclib-dropdown-item:disabled { opacity:.35; cursor:default; }
.odysseus-root .od-doclib-dropdown-danger { color:var(--red); }
.odysseus-root .od-doclib-card-expanded { flex-direction:column; cursor:default; }
.odysseus-root .od-doclib-preview { flex-basis:100%; width:100%; padding:8px 12px;
  font-family:'Fira Code', ui-monospace, monospace; font-size:9.5px; line-height:1.5;
  color:var(--hl-fg, var(--fg)); border-top:1px solid color-mix(in srgb, var(--border) 30%, transparent); margin:0; }
.odysseus-root .od-doclib-preview pre { margin:0; max-height:40vh; overflow-y:auto; white-space:pre-wrap;
  word-break:break-word; }
.odysseus-root .od-doclib-preview code { background:none; padding:0; font-family:inherit; }
.odysseus-root .od-doclib-expanded-actions { display:flex; align-items:flex-start; gap:6px; padding:8px 0 2px;
  border-top:1px solid color-mix(in srgb, var(--border) 30%, transparent); margin-top:4px; }
.odysseus-root .od-doclib-action-group { display:flex; flex-direction:column; gap:3px; margin-left:auto; }
.odysseus-root .od-doclib-text-btn { display:inline-flex; align-items:center; justify-content:center; gap:4px;
  box-sizing:border-box; font-size:10px; padding:3px 8px; border-radius:4px; background:none; border:1px solid var(--border);
  color:color-mix(in srgb, var(--fg) 60%, transparent); cursor:pointer; font-family:inherit;
  transition:border-color .15s, color .15s; }
.odysseus-root .od-doclib-text-btn:hover { border-color:var(--red); color:var(--red); }
.odysseus-root .od-doclib-text-btn:disabled { opacity:.35; cursor:not-allowed; }
.odysseus-root .od-doclib-text-btn-danger { color:var(--red); border-color:color-mix(in srgb, var(--red) 60%, transparent); }
.odysseus-root .od-doclib-text-btn-danger:hover { border-color:var(--red); color:var(--red); }
.odysseus-root .od-doclib-load-more { display:block; margin:8px auto 12px; padding:6px 16px; background:transparent;
  border:1px solid var(--border); border-radius:6px; color:color-mix(in srgb, var(--fg) 60%, transparent); font-size:11px;
  cursor:pointer; flex-shrink:0; font-family:inherit; transition:border-color .15s, color .15s; }
.odysseus-root .od-doclib-load-more:hover { border-color:var(--red); color:var(--red); }

/* ===== CalendarView ===== */

/* ── calendar view (od-cal-*) — ported 1:1 from odysseus calendar.js + the
   .cal-* rules in static/style.css, re-prefixed od- and scoped under
   .odysseus-root; colours mapped onto the theme CSS-vars so the theme engine
   recolours the clone. ── */
.odysseus-root .od-cal-panel { width:min(720px, 94vw); max-width:94vw; display:flex; flex-direction:row; gap:0; }
.odysseus-root .od-cal-body { flex:1; min-width:0; display:flex; flex-direction:column; gap:8px; padding:14px 16px; min-height:0; overflow:hidden; }

/* toolbar */
.odysseus-root .od-cal-toolbar { display:flex; align-items:center; gap:6px; flex-wrap:wrap; line-height:1; max-width:100%; row-gap:6px; }
.odysseus-root .od-cal-toolbar-nav { display:inline-flex; align-items:center; gap:4px; flex-wrap:wrap; }
.odysseus-root .od-cal-toolbar-right { display:inline-flex; align-items:center; gap:6px; margin-left:auto; flex-wrap:wrap; }
.odysseus-root .od-cal-title { font-size:13px; font-weight:600; white-space:nowrap; height:24px; line-height:24px; padding:0 6px; display:inline-flex; align-items:center; box-sizing:border-box; color:var(--fg); }
.odysseus-root button.od-cal-nav { display:inline-flex; align-items:center; justify-content:center; background:color-mix(in srgb, var(--fg) 6%, transparent); border:1px solid var(--border); color:var(--fg); border-radius:5px; padding:0 8px; height:24px; cursor:pointer; font-size:11px; font-family:inherit; box-sizing:border-box; }
.odysseus-root button.od-cal-nav:hover { background:color-mix(in srgb, var(--fg) 12%, transparent); }
.odysseus-root button.od-cal-today-btn { font-size:10px; opacity:0.5; }
.odysseus-root button.od-cal-today-btn:hover { opacity:1; }

/* +New pill */
.odysseus-root button.od-cal-add-btn.od-cal-add-btn-text { width:auto; background:color-mix(in srgb, var(--fg) 8%, transparent); color:var(--fg); border:1px solid var(--border); border-radius:12px; padding:0 10px 0 6px; display:inline-flex; align-items:center; gap:4px; height:24px; line-height:1; cursor:pointer; font-family:inherit; transition:background 0.15s, border-color 0.15s; }
.odysseus-root button.od-cal-add-btn.od-cal-add-btn-text:hover { background:color-mix(in srgb, var(--fg) 14%, transparent); border-color:var(--accent); opacity:1; }
.odysseus-root .od-cal-add-plus { display:inline-flex; align-items:center; color:var(--accent, var(--red)); transition:transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1); }
.odysseus-root button.od-cal-add-btn.od-cal-add-btn-text:hover .od-cal-add-plus { transform:rotate(180deg); }
.odysseus-root .od-cal-add-label { font-size:11px; font-weight:600; line-height:1; opacity:0.85; }

/* view toggle */
.odysseus-root .od-cal-view-toggle { display:inline-flex; align-items:stretch; border:1px solid var(--border); border-radius:5px; overflow:hidden; box-sizing:border-box; padding:0; margin:0; line-height:1; }
.odysseus-root button.od-cal-view-btn { display:inline-flex; align-items:center; justify-content:center; background:transparent; border:none; color:var(--fg); font-size:11px; font-family:inherit; font-weight:500; padding:2px 12px; margin:0; cursor:pointer; opacity:0.45; line-height:1; height:24px; box-sizing:border-box; }
.odysseus-root .od-cal-view-btn + .od-cal-view-btn { border-left:1px solid var(--border); }
.odysseus-root .od-cal-view-btn:hover { opacity:0.75; }
.odysseus-root .od-cal-view-btn.active { background:color-mix(in srgb, var(--fg) 12%, transparent); opacity:1; font-weight:600; }

/* filter chips */
.odysseus-root .od-cal-filters { display:flex; gap:6px; flex-wrap:wrap; }
.odysseus-root .od-cal-filter-item { display:inline-flex; align-items:center; gap:4px; cursor:pointer; font-size:10px; padding:1px 8px; line-height:1.4; border-radius:10px; background:color-mix(in srgb, var(--fg) 5%, transparent); border:1px solid var(--border); color:var(--fg); font-family:inherit; transition:opacity 0.15s; }
.odysseus-root .od-cal-filter-item:hover { background:color-mix(in srgb, var(--fg) 10%, transparent); }
.odysseus-root .od-cal-filter-item.od-cal-filter-off { opacity:0.25; text-decoration:line-through; }
.odysseus-root .od-cal-filter-dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }

/* month grid */
.odysseus-root .od-cal-grid { flex:1 1 auto; min-height:120px; overflow-y:auto; overflow-x:hidden; display:flex; flex-direction:column; gap:1px; background:color-mix(in srgb, var(--fg) 8%, transparent); border-radius:6px; }
.odysseus-root .od-cal-week-headers { display:grid; grid-template-columns:repeat(7,1fr); gap:1px; }
.odysseus-root .od-cal-week-row { position:relative; display:grid; grid-template-columns:repeat(7,1fr); gap:1px; }
.odysseus-root .od-cal-weekday { background:color-mix(in srgb, var(--fg) 5%, var(--bg)); text-align:center; font-size:10px; font-weight:600; opacity:0.4; padding:5px 0; color:var(--fg); }
.odysseus-root .od-cal-day { display:block; width:100%; text-align:left; background:var(--bg); min-height:78px; padding:3px; cursor:pointer; position:relative; transition:background 0.12s; overflow:hidden; border:none; font-family:inherit; color:var(--fg); }
.odysseus-root .od-cal-day:hover { background:color-mix(in srgb, var(--fg) 5%, var(--bg)); }
.odysseus-root .od-cal-day.od-cal-today { box-shadow:inset 0 0 0 2px var(--accent, var(--red)); background:color-mix(in srgb, var(--accent, var(--red)) 15%, var(--bg)); border-radius:8px; }
.odysseus-root .od-cal-day.od-cal-today .od-cal-day-num { color:var(--bg); font-weight:800; background:var(--accent, var(--red)); border-radius:10px; padding:1px 6px; display:inline-block; opacity:1; line-height:1.3; }
.odysseus-root .od-cal-day.od-cal-selected:not(.od-cal-today) { box-shadow:inset 0 0 0 2px color-mix(in srgb, var(--accent, var(--fg)) 65%, transparent); background:color-mix(in srgb, var(--accent, var(--fg)) 12%, var(--bg)); border-radius:8px; }
.odysseus-root .od-cal-day.od-cal-selected:not(.od-cal-today) .od-cal-day-num { color:var(--accent, var(--fg)); opacity:1; font-weight:700; }
.odysseus-root .od-cal-day.od-cal-other { opacity:0.25; }
.odysseus-root .od-cal-day-num { font-size:10px; font-weight:600; display:block; margin-bottom:1px; opacity:0.7; line-height:1.2; }
.odysseus-root .od-cal-event-row { display:flex; align-items:center; gap:3px; padding:1px 2px; border-radius:2px; line-height:1.15; margin-bottom:1px; }
.odysseus-root .od-cal-event-row:hover { background:color-mix(in srgb, var(--fg) 8%, transparent); }
.odysseus-root .od-cal-event-row-dot { width:4px; height:4px; border-radius:50%; flex-shrink:0; }
.odysseus-root .od-cal-event-row-time { font-size:9px; opacity:0.5; font-variant-numeric:tabular-nums; flex-shrink:0; }
.odysseus-root .od-cal-event-row-name { font-size:9px; opacity:0.8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; min-width:0; }
.odysseus-root .od-cal-event-more { font-size:8px; opacity:0.4; padding-left:6px; display:block; }

/* day-detail panel */
.odysseus-root .od-cal-day-detail { margin-top:4px; border-top:1px solid var(--border); padding-top:8px; max-height:200px; overflow-y:auto; overscroll-behavior:contain; flex-shrink:0; }
.odysseus-root .od-cal-detail-header { display:flex; justify-content:space-between; align-items:center; font-size:12px; font-weight:600; margin-bottom:6px; padding-right:8px; color:var(--fg); }
.odysseus-root .od-cal-empty { font-size:11px; opacity:0.3; padding:4px 0; color:var(--fg); }
.odysseus-root .od-cal-event-item { display:flex; gap:8px; padding:6px 8px; border-radius:5px; align-items:flex-start; }
.odysseus-root .od-cal-event-item:hover { background:color-mix(in srgb, var(--fg) 6%, transparent); }
.odysseus-root .od-cal-event-dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; margin-top:4px; }
.odysseus-root .od-cal-event-info { flex:1; min-width:0; }
.odysseus-root .od-cal-event-name { font-size:12px; font-weight:500; color:var(--fg); }
.odysseus-root .od-cal-event-time { font-size:10px; opacity:0.4; color:var(--fg); }

/* calendars sidebar (right rail of the modal) */
.odysseus-root .od-cal-sidebar { width:160px; flex-shrink:0; border-left:1px solid var(--border); padding:14px 10px; display:flex; flex-direction:column; gap:2px; overflow-y:auto; }
.odysseus-root .od-cal-sidebar-head { font-size:10px; text-transform:uppercase; letter-spacing:.04em; opacity:0.5; padding:0 6px 6px; color:var(--fg); }
.odysseus-root .od-cal-s-row { display:flex; align-items:center; gap:8px; width:100%; text-align:left; padding:5px 6px; border:none; background:none; border-radius:5px; cursor:pointer; color:var(--fg); font-family:inherit; font-size:12px; transition:background 0.12s; }
.odysseus-root .od-cal-s-row:hover { background:color-mix(in srgb, var(--fg) 8%, transparent); }
.odysseus-root .od-cal-s-row.od-cal-s-off { opacity:0.4; }
.odysseus-root .od-cal-s-dot { width:9px; height:9px; border-radius:50%; flex-shrink:0; }
.odysseus-root .od-cal-s-name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

@media (max-width: 768px) {
  .odysseus-root .od-cal-panel { flex-direction:column; }
  .odysseus-root .od-cal-sidebar { width:100%; border-left:none; border-top:1px solid var(--border); flex-direction:row; flex-wrap:wrap; }
  .odysseus-root .od-cal-day { min-height:44px; padding:2px; }
}



/* ===== EmailView ===== */
/* ── EmailView (odysseus emailLibrary.js + emailInbox.js + signature.js + the
   email-* rules in static/style.css). All scoped under .odysseus-root; colors
   via theme vars only. Append verbatim to ODYSSEUS_CSS in odysseus-theme.ts. ── */

.odysseus-root .od-email-panel {
  width: min(720px, 92vw); max-width: 92vw; height: 85vh; max-height: 85vh;
  display: flex; flex-direction: column; padding: 0; overflow: hidden; background: var(--bg);
}
.odysseus-root .od-email-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 12px 14px 10px; border-bottom: 1px solid var(--border); flex-shrink: 0;
}
.odysseus-root .od-email-head-title {
  display: inline-flex; align-items: center; gap: 6px; font-size: 15px; font-weight: 600; color: var(--fg);
}
.odysseus-root .od-email-head-title svg { vertical-align: -2px; }
.odysseus-root .od-email-unread-badge {
  font-size: 10px; font-weight: 600; padding: 1px 7px; border-radius: 10px;
  background: color-mix(in srgb, var(--accent, var(--red)) 18%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent, var(--red)) 40%, transparent);
  color: var(--accent, var(--red)); cursor: pointer;
}
.odysseus-root .od-email-stats { font-size: 11px; opacity: 0.55; font-weight: 400; color: var(--fg); }
.odysseus-root .od-email-close {
  background: none; border: none; color: var(--fg); opacity: 0.55; cursor: pointer;
  padding: 4px; line-height: 0; border-radius: 6px; display: inline-flex; transition: opacity 0.15s, background 0.15s;
}
.odysseus-root .od-email-close:hover { opacity: 1; background: color-mix(in srgb, var(--fg) 8%, transparent); }
.odysseus-root .od-email-desc { margin: 8px 14px 4px; font-size: 11px; opacity: 0.6; color: var(--fg); }
.odysseus-root .od-email-accounts-row { display: flex; align-items: center; gap: 6px; padding: 4px 14px 0; flex-shrink: 0; }
.odysseus-root .od-email-accounts { display: flex; gap: 4px; flex-wrap: wrap; flex: 1; min-width: 0; }
.odysseus-root .od-email-chip {
  height: 26px; box-sizing: border-box; padding: 0 11px; display: inline-flex; align-items: center;
  gap: 4px; border-radius: 13px; font-size: 11px; line-height: 1; border: 1px solid var(--border);
  background: none; color: var(--fg); cursor: pointer; transition: border-color 0.15s, background 0.15s;
}
.odysseus-root .od-email-chip:hover { border-color: var(--red); }
.odysseus-root .od-email-chip.active {
  background: color-mix(in srgb, var(--red) 15%, transparent);
  border-color: color-mix(in srgb, var(--red) 40%, transparent); color: var(--red);
}
.odysseus-root .od-email-compose-btn {
  flex-shrink: 0; margin-left: auto; display: inline-flex; align-items: center; gap: 3px;
  height: 26px; padding: 0 10px; border-radius: 6px; font-size: 11px; border: 1px solid var(--border);
  background: var(--panel); color: var(--fg); cursor: pointer; transition: border-color 0.15s, background 0.15s;
}
.odysseus-root .od-email-compose-btn:hover { border-color: var(--accent, var(--red)); }
.odysseus-root .od-email-toolbar { display: flex; flex-direction: column; gap: 6px; padding: 8px 14px; flex-shrink: 0; }
.odysseus-root .od-email-toolbar-row { display: flex; gap: 6px; align-items: center; }
.odysseus-root .od-email-search-row { display: flex; gap: 6px; align-items: center; }
.odysseus-root .od-email-select {
  flex: 1; min-width: 0; height: 28px; padding: 0 8px; border-radius: 6px; font-size: 11px;
  text-overflow: ellipsis; background: var(--bg); color: var(--fg); border: 1px solid var(--border); cursor: pointer;
}
.odysseus-root .od-email-tbtn {
  flex-shrink: 0; height: 28px; min-width: 28px; padding: 0 7px; border-radius: 6px;
  display: inline-flex; align-items: center; justify-content: center; background: var(--panel);
  color: var(--fg); border: 1px solid var(--border); cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
}
.odysseus-root .od-email-tbtn:hover { border-color: var(--accent, var(--red)); }
.odysseus-root .od-email-tbtn.active {
  background: color-mix(in srgb, var(--accent, var(--red)) 15%, transparent);
  border-color: color-mix(in srgb, var(--accent, var(--red)) 40%, transparent); color: var(--accent, var(--red));
}
.odysseus-root .od-email-search-wrap { position: relative; flex: 1; min-width: 120px; }
.odysseus-root .od-email-search-icon {
  position: absolute; left: 8px; top: 50%; transform: translateY(-50%); opacity: 0.45; pointer-events: none; color: var(--fg);
}
.odysseus-root .od-email-search {
  width: 100%; height: 28px; padding: 0 8px 0 26px; border-radius: 6px; font-size: 11px;
  background: var(--bg); color: var(--fg); border: 1px solid var(--border);
}
.odysseus-root .od-email-search::placeholder { color: color-mix(in srgb, var(--fg) 35%, transparent); }
.odysseus-root .od-email-body { display: flex; flex: 1; min-height: 0; border-top: 1px solid var(--border); }
.odysseus-root .od-email-list { width: 300px; flex-shrink: 0; overflow-y: auto; border-right: 1px solid var(--border); }
.odysseus-root .od-email-item {
  display: flex; align-items: flex-start; gap: 8px; width: 100%; text-align: left; padding: 8px 12px;
  cursor: pointer; border: none; background: none; border-bottom: 1px solid var(--border);
  position: relative; color: var(--fg); transition: background 0.1s;
}
.odysseus-root .od-email-item:hover { background: color-mix(in srgb, var(--fg) 3%, transparent); }
.odysseus-root .od-email-item:hover .od-email-item-menu { opacity: 0.5; }
.odysseus-root .od-email-item.od-email-selected { background: color-mix(in srgb, var(--accent, var(--red)) 8%, transparent); }
.odysseus-root .od-email-item.od-email-answered { opacity: 0.7; }
.odysseus-root .od-email-avatar {
  width: 28px; height: 28px; border-radius: 50%; color: #fff; flex-shrink: 0; display: flex;
  align-items: center; justify-content: center; font-size: 12px; font-weight: 600; margin-top: 1px;
}
.odysseus-root .od-email-item-content { flex: 1; min-width: 0; overflow: hidden; display: flex; flex-direction: column; }
.odysseus-root .od-email-item-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.odysseus-root .od-email-sender { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.odysseus-root .od-email-date { font-size: 10px; opacity: 0.5; white-space: nowrap; flex-shrink: 0; }
.odysseus-root .od-email-subject {
  font-size: 11px; opacity: 0.6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  margin-top: 1px; display: flex; align-items: center; gap: 4px;
}
.odysseus-root .od-email-unread-dot { display: inline-flex; align-items: center; flex-shrink: 0; }
.odysseus-root .od-email-attach-ico { opacity: 0.6; display: inline-flex; flex-shrink: 0; }
.odysseus-root .od-email-tags { display: inline-flex; gap: 3px; margin-left: 2px; }
.odysseus-root .od-email-tag {
  font-size: 9px; line-height: 1; padding: 2px 5px; border-radius: 8px; font-weight: 500;
  text-transform: uppercase; letter-spacing: 0.3px; background: color-mix(in srgb, var(--fg) 14%, transparent); color: var(--fg);
}
.odysseus-root .od-email-tag-urgent { background: color-mix(in srgb, var(--red) 25%, transparent); color: var(--red); font-weight: 600; }
.odysseus-root .od-email-tag-newsletter,
.odysseus-root .od-email-tag-marketing { background: color-mix(in srgb, var(--fg) 18%, transparent); }
.odysseus-root .od-email-item-menu { flex-shrink: 0; opacity: 0; color: var(--fg); padding: 4px 0; transition: opacity 0.15s; }
.odysseus-root .od-email-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 4px; padding: 28px 16px; text-align: center;
}
.odysseus-root .od-email-empty-title { font-size: 13px; opacity: 0.6; color: var(--fg); }
.odysseus-root .od-email-empty-sub { font-size: 11px; opacity: 0.45; color: var(--fg); }
.odysseus-root .od-email-pane { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.odysseus-root .od-email-pane-placeholder {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; opacity: 0.4; font-size: 12px; color: var(--fg);
}
.odysseus-root .od-email-reader { display: flex; flex-direction: column; flex: 1; min-height: 0; font-size: 12px; }
.odysseus-root .od-email-reader-header {
  display: flex; flex-direction: row; align-items: flex-start; gap: 12px; padding: 10px 14px;
  border-bottom: 1px solid var(--border); background: var(--bg); flex-shrink: 0;
}
.odysseus-root .od-email-reader-meta {
  flex: 1; min-width: 0; opacity: 0.85; line-height: 1.7; font-size: 11px; display: flex; flex-direction: column; gap: 4px;
}
.odysseus-root .od-email-reader-meta-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.odysseus-root .od-email-reader-meta-row strong { opacity: 0.5; font-weight: 600; flex-shrink: 0; min-width: 36px; }
.odysseus-root .od-email-recipient-chips { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.odysseus-root .od-email-recipient-chip {
  display: inline-flex; align-items: center; padding: 1px 8px; font-size: 10px;
  background: color-mix(in srgb, var(--fg) 6%, transparent); border: 1px solid var(--border);
  border-radius: 10px; color: var(--fg); white-space: nowrap; max-width: 220px; overflow: hidden; text-overflow: ellipsis;
}
.odysseus-root .od-email-reader-actions {
  display: flex; gap: 4px; flex-wrap: wrap; align-items: center; flex-shrink: 0; justify-content: flex-end; margin-top: -2px;
}
.odysseus-root .od-email-reader-btn {
  display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 8px; border-radius: 6px;
  font-size: 11px; background: var(--panel); color: var(--fg); border: 1px solid var(--border);
  cursor: pointer; transition: border-color 0.15s, background 0.15s;
}
.odysseus-root .od-email-reader-btn:hover { border-color: var(--accent, var(--red)); }
.odysseus-root .od-email-reader-subject {
  display: flex; align-items: center; gap: 6px; padding: 10px 14px 4px; font-size: 14px;
  font-weight: 600; color: var(--fg); flex-shrink: 0;
}
.odysseus-root .od-email-reader-star { color: var(--accent, var(--red)); opacity: 0.85; flex-shrink: 0; }
.odysseus-root .od-email-reader-body {
  font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-wrap: break-word; overflow-wrap: anywhere;
  flex: 1; overflow-y: auto; padding: 8px 14px 14px; min-height: 0; color: var(--fg);
}
.odysseus-root .od-email-compose { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.odysseus-root .od-email-compose-head {
  display: flex; align-items: center; justify-content: space-between; padding: 10px 14px;
  border-bottom: 1px solid var(--border); flex-shrink: 0;
}
.odysseus-root .od-email-compose-title { font-size: 13px; font-weight: 600; color: var(--fg); }
.odysseus-root .od-email-field {
  display: flex; align-items: center; gap: 8px; padding: 6px 14px; border-bottom: 1px solid var(--border); flex-shrink: 0;
}
.odysseus-root .od-email-field-label { font-size: 11px; opacity: 0.5; min-width: 50px; color: var(--fg); }
.odysseus-root .od-email-field-input {
  flex: 1; min-width: 0; height: 24px; font-size: 12px; background: transparent; border: none; color: var(--fg); outline: none;
}
.odysseus-root .od-email-compose-body {
  flex: 1; min-height: 0; resize: none; padding: 12px 14px; font-size: 12px; line-height: 1.55;
  background: transparent; border: none; color: var(--fg); outline: none; font-family: inherit;
}
.odysseus-root .od-email-compose-footer {
  display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-top: 1px solid var(--border); flex-shrink: 0;
}
.odysseus-root .od-email-compose-spacer { flex: 1; }
.odysseus-root .od-email-sig-btn {
  display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 10px; border-radius: 6px;
  font-size: 11px; background: var(--panel); color: var(--fg); border: 1px solid var(--border);
  cursor: pointer; transition: border-color 0.15s;
}
.odysseus-root .od-email-sig-btn:hover { border-color: var(--accent, var(--red)); }
.odysseus-root .od-email-send-btn {
  height: 28px; padding: 0 16px; border-radius: 6px; font-size: 11px; font-weight: 600;
  background: var(--accent, var(--red)); color: #fff; border: none; cursor: pointer; transition: opacity 0.15s;
}
.odysseus-root .od-email-send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.odysseus-root .od-email-sig-overlay { position: absolute; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; }
.odysseus-root .od-email-sig-panel {
  position: relative; z-index: 1; width: 420px; max-width: 90%; background: var(--panel);
  border: 1px solid var(--border); border-radius: 12px; padding: 16px; box-shadow: 0 12px 40px rgba(0,0,0,0.4);
}
.odysseus-root .od-email-sig-empty { padding: 16px; text-align: center; font-size: 12px; opacity: 0.55; color: var(--fg); }
.odysseus-root .od-email-sig-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 10px; }
.odysseus-root .od-email-sig-tile {
  display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 8px;
  border: 1px solid var(--border); border-radius: 8px; background: var(--bg); cursor: pointer; transition: border-color 0.15s;
}
.odysseus-root .od-email-sig-tile:hover { border-color: var(--accent, var(--red)); }
.odysseus-root .od-email-sig-tile img { max-width: 100%; height: 44px; object-fit: contain; }
.odysseus-root .od-email-sig-name { font-size: 11px; opacity: 0.85; color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
/* ===== GalleryView ===== */
/* ════════════════════════════════════════════════════════════════════
   Gallery — odysseus static/js/gallery.js (Photos tab) + style.css gallery
   rules, ported 1:1. Grid + detail lightbox + generate bar. All colors via
   theme vars, all selectors scoped under .odysseus-root.
   ════════════════════════════════════════════════════════════════════ */

.odysseus-root .od-gallery-panel {
  width: min(960px, 94vw);
  max-width: 94vw;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
}

/* ── Header (gallery.js .modal-header) ── */
.odysseus-root .od-gallery-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px 8px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.odysseus-root .od-gallery-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  color: var(--fg);
}
.odysseus-root .od-gallery-stats {
  font-size: 10px;
  font-weight: normal;
  color: color-mix(in srgb, var(--fg) 50%, transparent);
  margin-left: 4px;
}
.odysseus-root .od-gallery-close {
  background: none;
  border: none;
  color: var(--fg);
  opacity: 0.6;
  cursor: pointer;
  padding: 2px;
  display: inline-flex;
  border-radius: 4px;
  transition: opacity 0.15s, background 0.15s;
}
.odysseus-root .od-gallery-close:hover {
  opacity: 1;
  background: color-mix(in srgb, var(--fg) 10%, transparent);
}

/* ── Tabs (style.css .gallery-tabs / .gallery-tab) ── */
.odysseus-root .od-gallery-tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--border);
  padding: 0 16px;
  background: var(--panel);
  flex-shrink: 0;
}
.odysseus-root .od-gallery-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 18px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--fg);
  opacity: 0.6;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  transition: opacity 0.15s, border-color 0.15s;
}
.odysseus-root .od-gallery-tab:hover {
  opacity: 0.85;
}
.odysseus-root .od-gallery-tab.active {
  opacity: 1;
  border-bottom-color: var(--red);
}
.odysseus-root .od-gallery-tab-icon {
  display: inline-flex;
  align-items: center;
  opacity: 0.85;
}
.odysseus-root .od-gallery-tab.active .od-gallery-tab-icon {
  opacity: 1;
}

/* ── Body ── */
.odysseus-root .od-gallery-body {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  padding: 8px 14px 12px;
}
.odysseus-root .od-gallery-images-container {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
.odysseus-root .od-gallery-secondary {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

/* ── Toolbar (style.css .gallery-toolbar) ── */
.odysseus-root .od-gallery-toolbar {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
  align-items: center;
  flex-shrink: 0;
}
.odysseus-root .od-gallery-search-wrap {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
}
.odysseus-root .od-gallery-search-icon {
  position: absolute;
  left: 9px;
  color: color-mix(in srgb, var(--fg) 45%, transparent);
  pointer-events: none;
}
.odysseus-root .od-gallery-search {
  flex: 1;
  width: 100%;
  padding: 5px 8px 5px 28px;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 6px;
  font: inherit;
  font-size: 12px;
  outline: none;
  box-sizing: border-box;
}
.odysseus-root .od-gallery-search:focus {
  border-color: var(--red);
}
.odysseus-root .od-gallery-search::placeholder {
  color: color-mix(in srgb, var(--fg) 35%, transparent);
}
.odysseus-root .od-gallery-model-filter,
.odysseus-root .od-gallery-sort {
  padding: 5px 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--fg);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.odysseus-root .od-gallery-select-btn {
  padding: 6px 11px;
  background: transparent;
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
  font-size: 11px;
  font-family: inherit;
  opacity: 0.6;
  transition: all 0.15s;
}
.odysseus-root .od-gallery-select-btn:hover {
  opacity: 1;
}
.odysseus-root .od-gallery-select-btn.active {
  background: color-mix(in srgb, var(--red) 28%, transparent);
  color: var(--red);
  border-color: var(--red);
  font-weight: 600;
  opacity: 1;
}

/* ── Grid (style.css .gallery-grid / .gallery-card) ── */
.odysseus-root .od-gallery-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 8px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 2px;
}
.odysseus-root .od-gallery-card {
  position: relative;
  aspect-ratio: 1;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--border);
  background: none;
  padding: 0;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
}
.odysseus-root .od-gallery-card:hover {
  border-color: var(--red);
  box-shadow: 0 2px 8px color-mix(in srgb, var(--red) 15%, transparent);
  transform: translateY(-1px);
}
.odysseus-root .od-gallery-card-upload {
  border-style: dashed;
  background: color-mix(in srgb, var(--fg) 3%, var(--bg));
  opacity: 0.75;
  transition: opacity 0.12s, border-color 0.15s, transform 0.15s;
}
.odysseus-root .od-gallery-card-upload:hover {
  opacity: 1;
  border-color: var(--red);
  transform: translateY(-1px);
}
.odysseus-root .od-gallery-card-upload-inner {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--fg);
}
.odysseus-root .od-gallery-card-upload-label {
  font-size: 12px;
  font-weight: 500;
  opacity: 0.8;
}
.odysseus-root .od-gallery-card-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.odysseus-root .od-gallery-fav-btn {
  position: absolute;
  top: 4px;
  right: 4px;
  z-index: 2;
  background: rgba(0, 0, 0, 0.4);
  border: none;
  border-radius: 50%;
  width: 26px;
  height: 26px;
  color: rgba(255, 255, 255, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.15s;
  padding: 0;
}
.odysseus-root .od-gallery-card:hover .od-gallery-fav-btn {
  opacity: 1;
}
.odysseus-root .od-gallery-fav-btn.od-gallery-fav-active {
  opacity: 1;
  color: var(--red);
}
.odysseus-root .od-gallery-dl-btn {
  position: absolute;
  top: 4px;
  left: 4px;
  z-index: 2;
  background: rgba(0, 0, 0, 0.4);
  border: none;
  border-radius: 50%;
  width: 26px;
  height: 26px;
  color: rgba(255, 255, 255, 0.75);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s;
  padding: 0;
}
.odysseus-root .od-gallery-card:hover .od-gallery-dl-btn {
  opacity: 1;
}
.odysseus-root .od-gallery-dl-btn:hover {
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
}
.odysseus-root .od-gallery-select-dot {
  position: absolute;
  top: 6px;
  left: 6px;
  z-index: 2;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--fg) 30%, transparent);
  border: 1px solid color-mix(in srgb, var(--fg) 50%, transparent);
}
.odysseus-root .od-gallery-card-info {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 6px 8px;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.75));
  color: #fff;
  text-align: left;
}
.odysseus-root .od-gallery-card-prompt {
  font-size: 10px;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.odysseus-root .od-gallery-card-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
  font-size: 9px;
  opacity: 0.8;
}
.odysseus-root .od-gallery-card-model {
  padding: 1px 5px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.15);
}

/* Empty state (style.css .gallery-empty) — honest "No images yet". */
.odysseus-root .od-gallery-empty {
  grid-column: 1 / -1;
  text-align: center;
  color: color-mix(in srgb, var(--fg) 35%, transparent);
  padding: 32px 16px;
  font-size: 12px;
  font-style: italic;
}

/* ── Generate prompt bar (no eliza image backend → disabled CTA + note) ── */
.odysseus-root .od-gallery-generate-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 8px 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  flex-shrink: 0;
}
.odysseus-root .od-gallery-generate-icon {
  color: var(--accent, var(--red));
  opacity: 0.85;
  flex-shrink: 0;
}
.odysseus-root .od-gallery-generate-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  color: var(--fg);
  font: inherit;
  font-size: 13px;
  outline: none;
}
.odysseus-root .od-gallery-generate-input::placeholder {
  color: color-mix(in srgb, var(--fg) 35%, transparent);
}
.odysseus-root .od-gallery-generate-btn {
  padding: 6px 14px;
  background: var(--accent, var(--red));
  color: #fff;
  border: 1px solid transparent;
  border-radius: 6px;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  flex-shrink: 0;
  transition: opacity 0.15s;
}
.odysseus-root .od-gallery-generate-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.odysseus-root .od-gallery-generate-note {
  margin-top: 5px;
  font-size: 10.5px;
  font-style: italic;
  color: color-mix(in srgb, var(--fg) 45%, transparent);
  flex-shrink: 0;
}

/* ── Settings tab card (style.css .admin-card) ── */
.odysseus-root .od-gallery-settings-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  background: color-mix(in srgb, var(--fg) 2%, var(--panel));
}
.odysseus-root .od-gallery-settings-title {
  margin: 0 0 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--fg);
}
.odysseus-root .od-gallery-settings-desc {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: color-mix(in srgb, var(--fg) 60%, transparent);
}

/* ── Detail lightbox (style.css .gallery-detail*) ── */
.odysseus-root .od-gallery-detail {
  position: absolute;
  inset: 0;
  background: var(--panel);
  z-index: 10;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}
.odysseus-root .od-gallery-detail-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  position: sticky;
  top: 0;
  background: var(--panel);
  z-index: 5;
}
.odysseus-root .od-gallery-detail-spacer {
  flex: 1;
}
.odysseus-root .od-gallery-detail-back {
  background: none;
  border: none;
  color: var(--fg);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 4px;
}
.odysseus-root .od-gallery-detail-back:hover {
  background: color-mix(in srgb, var(--fg) 10%, transparent);
}
.odysseus-root .od-gallery-detail-fav {
  background: none;
  border: 1px solid var(--border);
  color: var(--fg);
  opacity: 0.7;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.15s, color 0.15s, border-color 0.15s;
}
.odysseus-root .od-gallery-detail-fav:hover {
  opacity: 1;
}
.odysseus-root .od-gallery-detail-fav.active {
  opacity: 1;
  color: var(--red);
  border-color: var(--red);
}
.odysseus-root .od-gallery-detail-menu-wrap {
  position: relative;
}
.odysseus-root .od-gallery-detail-menu-btn {
  background: none;
  border: 1px solid var(--border);
  color: var(--fg);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 26px;
  padding: 0;
  border-radius: 4px;
  transition: border-color 0.15s;
}
.odysseus-root .od-gallery-detail-menu-btn:hover {
  border-color: var(--fg);
}
.odysseus-root .od-gallery-detail-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  min-width: 150px;
  padding: 3px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 4px 14px color-mix(in srgb, var(--fg) 18%, transparent);
  z-index: 12;
  display: flex;
  flex-direction: column;
}
.odysseus-root .od-gallery-detail-menu-item {
  width: 100%;
  background: none;
  border: none;
  text-align: left;
  font: inherit;
  color: var(--fg);
  padding: 5px 8px;
  font-size: 11px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border-radius: 4px;
  cursor: pointer;
}
.odysseus-root .od-gallery-detail-menu-item:hover {
  background: color-mix(in srgb, var(--red) 10%, transparent);
}
.odysseus-root .od-gallery-detail-menu-danger {
  color: var(--red);
}
.odysseus-root .od-gallery-detail-body {
  display: flex;
  gap: 16px;
  padding: 12px;
  flex: 1;
  min-height: 0;
}
.odysseus-root .od-gallery-detail-image {
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
}
.odysseus-root .od-gallery-detail-img-frame {
  position: relative;
  display: inline-flex;
  max-width: 100%;
  max-height: 70vh;
}
.odysseus-root .od-gallery-detail-img {
  max-width: 100%;
  max-height: 70vh;
  border-radius: 6px;
  object-fit: contain;
  display: block;
}
.odysseus-root .od-gallery-detail-nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  background: rgba(0, 0, 0, 0.45);
  color: rgba(255, 255, 255, 0.85);
  border: none;
  border-radius: 50%;
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s;
  z-index: 3;
  padding: 0;
}
.odysseus-root .od-gallery-detail-image:hover .od-gallery-detail-nav {
  opacity: 0.85;
}
.odysseus-root .od-gallery-detail-nav:hover {
  opacity: 1 !important;
  background: rgba(0, 0, 0, 0.7);
}
.odysseus-root .od-gallery-detail-nav-prev {
  left: 8px;
}
.odysseus-root .od-gallery-detail-nav-next {
  right: 8px;
}
.odysseus-root .od-gallery-detail-nav-disabled {
  opacity: 0 !important;
  pointer-events: none;
}
.odysseus-root .od-gallery-detail-rotate {
  position: absolute;
  top: 8px;
  background: rgba(0, 0, 0, 0.45);
  color: rgba(255, 255, 255, 0.85);
  border: none;
  border-radius: 50%;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s;
  z-index: 3;
  padding: 0;
}
.odysseus-root .od-gallery-detail-image:hover .od-gallery-detail-rotate {
  opacity: 0.85;
}
.odysseus-root .od-gallery-detail-rotate:hover {
  opacity: 1 !important;
  background: rgba(0, 0, 0, 0.7);
}
.odysseus-root .od-gallery-detail-rotate-ccw {
  left: 8px;
}
.odysseus-root .od-gallery-detail-rotate-cw {
  right: 8px;
}
.odysseus-root .od-gallery-detail-sidebar {
  width: 240px;
  flex-shrink: 0;
  overflow-x: hidden;
  overflow-y: auto;
  min-width: 0;
}
.odysseus-root .od-gallery-detail-section {
  margin-bottom: 12px;
}
.odysseus-root .od-gallery-detail-label,
.odysseus-root .od-gallery-detail-section > label {
  display: block;
  font-size: 10px;
  font-weight: 600;
  opacity: 0.6;
  margin-bottom: 3px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--fg);
}
.odysseus-root .od-gallery-detail-section > div {
  font-size: 12px;
  word-break: break-word;
  color: var(--fg);
}
.odysseus-root .od-gallery-detail-prompt {
  white-space: pre-wrap;
  line-height: 1.4;
}
.odysseus-root .od-gallery-tag-input,
.odysseus-root .od-gallery-detail-name-input {
  width: 100%;
  padding: 5px 8px;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 4px;
  font: inherit;
  font-size: 11px;
  box-sizing: border-box;
}
.odysseus-root .od-gallery-detail-name-input {
  font-size: 13px;
  font-weight: 500;
}
.odysseus-root .od-gallery-tag-input:focus,
.odysseus-root .od-gallery-detail-name-input:focus {
  border-color: var(--red);
  outline: none;
}

/* Narrow: stack detail body, full-width sidebar (style.css gallery @media). */
@media (max-width: 768px) {
  .odysseus-root .od-gallery-detail-body {
    flex-direction: column;
  }
  .odysseus-root .od-gallery-detail-sidebar {
    width: 100%;
  }
}
/* ===== CookbookView ===== */
/* ── Cookbook (CookbookView.tsx). odysseus cookbook.js modal + .doclib-card
   .skill-card recipe grid + codeRunner.js run-output panel + cookbook-* button
   rules, scoped under .odysseus-root. Base .od-search-overlay / .od-search-backdrop
   / .od-search-panel / .od-mem-head / .od-mem-title / .od-mem-stats /
   .od-search-empty already live in ODYSSEUS_CSS — only cookbook-specific
   .od-cb-* classes are added here. All colors via theme vars. ── */

/* Panel: a tall centered modal like the cookbook modal (#cookbook-modal). */
.odysseus-root .od-cb-panel {
  width: 640px;
  max-width: 92%;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  padding: 14px 16px 16px;
  gap: 10px;
}

/* Head row: title · stats · refresh (cookbook.js modal header). The shared
   .od-mem-head supplies the baseline flex; refresh pins to the right. */
.odysseus-root .od-cb-head { align-items: center; }
.odysseus-root .od-cb-refresh {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  background: none;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--fg);
  opacity: 0.7;
  cursor: pointer;
  transition: opacity 0.15s, border-color 0.15s, color 0.15s;
}
.odysseus-root .od-cb-refresh:hover {
  opacity: 1;
  border-color: var(--accent);
  color: var(--accent);
}
.odysseus-root .od-cb-refresh:disabled { opacity: 0.4; cursor: default; }
@keyframes od-cb-spin { to { transform: rotate(360deg); } }
.odysseus-root .od-cb-spin { animation: od-cb-spin 0.8s linear infinite; }

/* Search row (cookbook hwfit-search styling — icon + flat input). */
.odysseus-root .od-cb-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--fg) 3%, transparent);
}
.odysseus-root .od-cb-search-icon {
  color: color-mix(in srgb, var(--fg) 45%, transparent);
  flex-shrink: 0;
}
.odysseus-root .od-cb-search-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: var(--fg);
  font-size: 13px;
  font-family: inherit;
}
.odysseus-root .od-cb-search-input::placeholder {
  color: color-mix(in srgb, var(--fg) 35%, transparent);
}

/* Recipe grid — .doclib-grid: a vertical list of cards, scrollable. */
.odysseus-root .od-cb-grid {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: thin;
}
.odysseus-root .od-cb-grid::-webkit-scrollbar { width: 4px; }
.odysseus-root .od-cb-grid::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--fg) 15%, transparent);
  border-radius: 4px;
}

.odysseus-root .od-cb-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 28px 16px;
  font-size: 12px;
  color: color-mix(in srgb, var(--fg) 45%, transparent);
}

/* Recipe card — .doclib-card.skill-card: bordered, hoverable, expands. */
.odysseus-root .od-cb-card {
  background: color-mix(in srgb, var(--fg) 3%, transparent);
  border: 1px solid var(--border);
  border-radius: 8px;
  transition: background 0.15s, border-color 0.15s;
  position: relative;
}
.odysseus-root .od-cb-card:hover {
  background: color-mix(in srgb, var(--fg) 5%, transparent);
  border-color: color-mix(in srgb, var(--fg) 16%, transparent);
}
.odysseus-root .od-cb-card-expanded {
  border-color: color-mix(in srgb, var(--accent) 35%, transparent);
}

/* Collapsed header row — icon · name+desc column · right badges/chevron.
   Matches .skill-card-header (min-height 46px tap target). */
.odysseus-root .od-cb-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 46px;
  box-sizing: border-box;
  padding: 7px 10px;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  color: var(--fg);
  font-family: inherit;
}
.odysseus-root .od-cb-card-icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  color: var(--accent);
  opacity: 0.85;
}
.odysseus-root .od-cb-lang-svg { display: block; }
.odysseus-root .od-cb-card-textcol {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.odysseus-root .od-cb-card-name {
  font-weight: 600;
  font-size: 12.5px;
  line-height: 1.3;
  word-break: break-word;
}
.odysseus-root .od-cb-card-desc {
  font-size: 10px;
  opacity: 0.55;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.odysseus-root .od-cb-card-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  margin-left: auto;
}

/* Status / state badges — .memory-cat-badge clone. */
.odysseus-root .od-cb-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  text-transform: lowercase;
  white-space: nowrap;
  background: color-mix(in srgb, var(--fg) 8%, transparent);
  color: color-mix(in srgb, var(--fg) 55%, transparent);
}
.odysseus-root .od-cb-badge-on {
  background: color-mix(in srgb, var(--ok, var(--accent)) 22%, transparent);
  color: var(--ok, var(--accent));
}
.odysseus-root .od-cb-badge-off {
  background: color-mix(in srgb, var(--fg) 8%, transparent);
  color: color-mix(in srgb, var(--fg) 45%, transparent);
}
.odysseus-root .od-cb-badge-warning {
  background: color-mix(in srgb, var(--red) 20%, transparent);
  color: var(--red);
}
.odysseus-root .od-cb-badge-critical,
.odysseus-root .od-cb-badge-blocked {
  background: color-mix(in srgb, var(--red) 28%, transparent);
  color: var(--red);
  border: 1px solid color-mix(in srgb, var(--red) 40%, transparent);
}
.odysseus-root .od-cb-chevron {
  display: inline-flex;
  align-items: center;
  opacity: 0.5;
  flex-shrink: 0;
}

/* Expanded preview — .doclib-card-preview: top-bordered detail body. */
.odysseus-root .od-cb-card-preview {
  border-top: 1px solid color-mix(in srgb, var(--border) 40%, transparent);
  padding: 8px 12px 10px;
}
.odysseus-root .od-cb-md-pre {
  margin: 0;
  font-family: "Berkeley Mono", "SF Mono", "Fira Code", monospace;
  font-size: 11.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--txt, var(--fg));
  max-height: 320px;
  overflow-y: auto;
}

/* Run-output panel (codeRunner.js .code-runner-output) — honest unavailable
   state, never fabricated program output. */
.odysseus-root .od-cb-run-output {
  margin: 8px 0 0;
  padding: 8px 10px;
  background: color-mix(in srgb, var(--fg) 4%, transparent);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: "Fira Code", monospace;
  font-size: 11px;
  line-height: 1.45;
  color: color-mix(in srgb, var(--fg) 55%, transparent);
  font-style: italic;
}

/* Action footer — .doclib-card-expanded-actions: Run left, Copy/Download
   right-grouped (.doclib-action-group margin-left:auto). */
.odysseus-root .od-cb-card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 8px;
  margin-top: 8px;
  border-top: 1px solid color-mix(in srgb, var(--border) 40%, transparent);
}
.odysseus-root .od-cb-action-group {
  display: flex;
  gap: 6px;
  margin-left: auto;
}
.odysseus-root .od-cb-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  box-sizing: border-box;
  font-size: 10px;
  padding: 3px 8px;
  border-radius: 4px;
  background: none;
  border: 1px solid var(--border);
  color: var(--muted, color-mix(in srgb, var(--fg) 60%, transparent));
  cursor: pointer;
  font-family: inherit;
  transition: border-color 0.15s, color 0.15s, opacity 0.15s;
}
.odysseus-root .od-cb-action-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.odysseus-root .od-cb-action-btn:disabled { opacity: 0.4; cursor: default; }
/* Run button — accent fill (.cookbook-run-btn). Disabled until an execution
   backend exists, matching the honest run-output state. */
.odysseus-root .od-cb-run-btn:not(:disabled) {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--panel);
  font-weight: 600;
}
/* ===== ModelsView ===== */
/* ===== ModelsView ===== */
/* Port of odysseus model catalog (static/js/models.js + modelPicker.js +
   providers.js + style.css model rules). Panel is a 2-column body: a provider
   rail (which provider to scan) + the catalogue list (sort menu, search box,
   Favorites + provider endpoint groups, model rows). All colors via theme vars;
   spacing/sizes copied 1:1 from style.css. Append inside ODYSSEUS_CSS in
   odysseus-theme.ts (everything scoped under .odysseus-root). */

/* Panel: reuse the shared .od-search-panel chrome but widen + give it height
   for the catalogue (mirrors odysseus's models surface, larger than the 560px
   search palette). */
.odysseus-root .od-models-panel {
  width: min(820px, 94vw);
  height: min(80vh, 720px);
  max-width: none;
  display: flex;
  flex-direction: column;
  padding: 0;
}
.odysseus-root .od-models-body {
  flex: 1;
  display: flex;
  min-height: 0;
  border-top: 1px solid color-mix(in srgb, var(--fg) 6%, transparent);
}

/* ── Provider rail (providers.js — pick which provider to scan) ── */
.odysseus-root .od-models-providers {
  width: 168px;
  flex-shrink: 0;
  border-right: 1px solid color-mix(in srgb, var(--fg) 6%, transparent);
  padding: 8px 8px 12px;
  overflow-y: auto;
}
.odysseus-root .od-models-providers-head {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.5;
  padding: 5px 8px 6px;
}
.odysseus-root .od-models-provider-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 4px;
  background: none;
  color: color-mix(in srgb, var(--fg) 70%, transparent);
  font-size: 12px;
  text-transform: capitalize;
  cursor: pointer;
  transition: background 0.08s, color 0.08s;
}
.odysseus-root .od-models-provider-row:hover {
  background: color-mix(in srgb, var(--fg) 5%, transparent);
  color: var(--fg);
}
.odysseus-root .od-models-provider-row.active {
  background: color-mix(in srgb, var(--red) 10%, transparent);
  color: var(--fg);
}
.odysseus-root .od-models-provider-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.odysseus-root .od-models-provider-count {
  flex-shrink: 0;
  font-size: 10px;
  opacity: 0.5;
  font-variant-numeric: tabular-nums;
}

/* ── Catalogue column ── */
.odysseus-root .od-models-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 8px 12px 12px;
}
.odysseus-root .od-models-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 6px;
}
.odysseus-root .od-models-sort-wrap { position: relative; }
.odysseus-root .od-models-sort-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  font-size: 11px;
  font-family: inherit;
  background: none;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: color-mix(in srgb, var(--fg) 60%, transparent);
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
}
.odysseus-root .od-models-sort-btn:hover {
  border-color: var(--red);
  color: var(--fg);
  background: color-mix(in srgb, var(--fg) 5%, transparent);
}
.odysseus-root .od-models-sort-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 5;
  min-width: 140px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  padding: 4px;
}
.odysseus-root .od-models-sort-item {
  display: block;
  width: 100%;
  padding: 6px 8px;
  text-align: left;
  background: none;
  border: none;
  border-radius: 4px;
  color: var(--fg);
  font-size: 12px;
  cursor: pointer;
}
.odysseus-root .od-models-sort-item:hover {
  background: color-mix(in srgb, var(--red) 8%, transparent);
}
.odysseus-root .od-models-sort-item.current {
  color: var(--red);
  font-weight: 600;
}

/* In-list search (style.css .model-search-input, line 3661). */
.odysseus-root .od-models-search-row {
  position: relative;
  margin-bottom: 6px;
}
.odysseus-root .od-models-search-icon {
  position: absolute;
  left: 9px;
  top: 50%;
  transform: translateY(-50%);
  color: color-mix(in srgb, var(--fg) 35%, transparent);
  pointer-events: none;
}
.odysseus-root .od-model-search-input {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 10px 6px 28px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--fg);
  font-family: inherit;
  font-size: 0.8rem;
  outline: none;
  transition: border-color 0.15s;
}
.odysseus-root .od-model-search-input:focus { border-color: var(--red); }
.odysseus-root .od-model-search-input::placeholder {
  color: color-mix(in srgb, var(--fg) 30%, transparent);
}

.odysseus-root .od-models-scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

/* Category / endpoint group headers (style.css lines 1468-1493). */
.odysseus-root .od-models-category-header,
.odysseus-root .od-models-endpoint-label {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 8px;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.85em;
  font-weight: 600;
  text-align: left;
  text-transform: capitalize;
  color: color-mix(in srgb, var(--fg) 55%, transparent);
  border-radius: 4px;
  user-select: none;
  transition: background 0.08s, color 0.08s;
}
.odysseus-root .od-models-category-header { margin-top: 4px; }
.odysseus-root .od-models-category-header:hover,
.odysseus-root .od-models-endpoint-label:hover {
  color: var(--fg);
  background: color-mix(in srgb, var(--fg) 4%, transparent);
}
.odysseus-root .od-folder-toggle {
  font-size: 0.7em;
  width: 10px;
  text-align: center;
  flex-shrink: 0;
}
.odysseus-root .od-folder-count {
  font-weight: 400;
  opacity: 0.5;
  font-size: 0.9em;
}
.odysseus-root .od-models-group-content.indented { padding-left: 4px; }

/* Model row (style.css lines 3624-3633 + 1304 hover). */
.odysseus-root .od-models-row {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--border);
  padding: 4px;
  margin: 4px 0;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.08s, border-color 0.08s;
}
.odysseus-root .od-models-row:hover {
  background: color-mix(in srgb, var(--red) 8%, transparent);
  border-color: var(--red);
}
.odysseus-root .od-models-drag {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  color: color-mix(in srgb, var(--fg) 30%, transparent);
  cursor: grab;
}
.odysseus-root .od-models-grow {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--fg);
}

/* Favorite dot / provider-logo holder (style.css lines 3634-3660 + 7179). */
.odysseus-root .od-model-fav-btn {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1.5px solid color-mix(in srgb, var(--fg) 22%, transparent);
  flex-shrink: 0;
  cursor: pointer;
  background: none;
  padding: 0;
  margin-left: 4px;
  position: relative;
  transition: all 0.15s;
}
.odysseus-root .od-model-fav-btn:hover {
  border-color: var(--fg);
  background: color-mix(in srgb, var(--fg) 27%, transparent);
  transform: scale(1.3);
}
.odysseus-root .od-model-fav-btn.active {
  background: var(--fg);
  border-color: var(--fg);
}
.odysseus-root .od-model-fav-btn.active:hover { opacity: 0.6; }
/* When a provider logo matches, the dot becomes a 14px logo holder. */
.odysseus-root .od-model-fav-btn.od-provider-logo {
  width: 14px;
  height: 14px;
  border: none;
  border-radius: 0;
  background: none;
  opacity: 0.4;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--fg);
}
.odysseus-root .od-model-fav-btn.od-provider-logo.active { opacity: 1; }
.odysseus-root .od-model-fav-btn.od-provider-logo:hover {
  opacity: 1;
  transform: scale(1.2);
  background: none;
}
.odysseus-root .od-model-fav-btn.od-provider-logo svg {
  width: 14px;
  height: 14px;
  display: block;
}

/* IMG badge (style.css models.js inline badge). */
.odysseus-root .od-model-type-badge {
  font-size: 0.65em;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--accent);
  color: var(--bg);
  flex-shrink: 0;
}

/* "+ Chat" / "+ Image" action (style.css .model-chat-btn + .models-row button). */
.odysseus-root .od-model-chat-btn {
  margin-left: auto;
  flex-shrink: 0;
  height: 24px;
  padding: 0 8px;
  font-size: 9px;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.08s, border-color 0.08s;
}
.odysseus-root .od-model-chat-btn:hover { border-color: var(--red); }

/* "Show N more" overflow (style.css .models-show-all-btn inline). */
.odysseus-root .od-models-show-all-btn {
  display: block;
  width: 100%;
  text-align: center;
  padding: 6px;
  background: none;
  border: none;
  opacity: 0.5;
  cursor: pointer;
  font-size: 0.82em;
  color: var(--fg);
  transition: opacity 0.15s;
}
.odysseus-root .od-models-show-all-btn:hover { opacity: 0.8; }

/* Empty / loading / error states (style.css .models-empty-state line 7176 +
   .muted-sm / .accent-link). */
.odysseus-root .od-models-empty-state {
  text-align: center;
  padding: 16px 8px;
  line-height: 1.6;
}
.odysseus-root .od-models-muted {
  color: color-mix(in srgb, var(--fg) 50%, transparent);
  font-size: 13px;
}
.odysseus-root .od-models-muted-sm {
  opacity: 0.45;
  font-size: 0.8em;
  color: var(--fg);
}
.odysseus-root .od-models-retry-link {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font-size: 0.85em;
  padding: 4px 0 0;
}
.odysseus-root .od-models-retry-link:hover { text-decoration: underline; }
/* ===== TasksView ===== */
/* ── Tasks modal (odysseus static/js/tasks.js + style.css .task-* / .memory-* rules).
   Real-wired orchestrator task list. All scoped under .odysseus-root, colours via theme vars. ── */

/* Panel — override the shared .od-search-panel sizing to odysseus's centered
   ~600px modal (.tasks-modal-content { max-width:600px; width:min(600px,92vw) }). */
.odysseus-root .od-search-panel.od-tasks-panel {
  width: min(600px, 92vw);
  max-width: 600px;
  max-height: 85vh;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 0;
  overflow: hidden;
  font-size: 12px;
}

/* Modal header (.modal-header) */
.odysseus-root .od-tasks-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-bottom: 8px;
}
.odysseus-root .od-tasks-header-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
}
.odysseus-root .od-tasks-header-spacer { flex: 1; }
.odysseus-root .od-tasks-close {
  background: none;
  border: none;
  color: color-mix(in srgb, var(--fg) 55%, transparent);
  cursor: pointer;
  display: inline-flex;
  padding: 2px;
  border-radius: 6px;
  transition: color 0.15s, background 0.15s;
}
.odysseus-root .od-tasks-close:hover {
  color: var(--fg);
  background: color-mix(in srgb, var(--fg) 8%, transparent);
}

/* Tab bar (.memory-tabs .tasks-tabs) — full-bleed underline re-inset 10px. */
.odysseus-root .od-tasks-tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--border);
  margin: -2px -10px 8px;
  padding: 0 10px;
  flex-shrink: 0;
}
.odysseus-root .od-tasks-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: none;
  border: none;
  color: var(--fg);
  opacity: 0.5;
  font-size: 12px;
  font-family: inherit;
  padding: 8px 14px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: opacity 0.15s, border-color 0.15s, color 0.15s, background 0.15s;
}
.odysseus-root .od-tasks-tab:hover {
  opacity: 0.8;
  background: color-mix(in srgb, var(--fg) 5%, transparent);
}
.odysseus-root .od-tasks-tab.active {
  opacity: 1;
  color: var(--red);
  border-bottom-color: var(--red);
}
.odysseus-root .od-tasks-tab-count {
  font-size: 0.8em;
  opacity: 0.6;
  font-weight: normal;
  margin-left: 4px;
}

/* Body + card (.modal-body + .admin-card) */
.odysseus-root .od-tasks-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.odysseus-root .od-tasks-card {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
}
.odysseus-root .od-tasks-headrow {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 2px;
}
.odysseus-root .od-tasks-h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.03em;
  line-height: 1;
  color: var(--fg);
}
.odysseus-root .od-tasks-head-count {
  font-size: 0.6em;
  opacity: 0.6;
  font-weight: normal;
}
.odysseus-root .od-tasks-desc {
  margin: 4px 0 0;
  font-size: 11px;
  line-height: 1.5;
  color: color-mix(in srgb, var(--fg) 50%, transparent);
}

/* Toolbar (.memory-toolbar + .memory-toolbar-btn + sort + search) */
.odysseus-root .od-tasks-toolbar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 4px 0 8px;
}
.odysseus-root .od-tasks-toolbar-left {
  display: flex;
  align-items: center;
  gap: 6px;
}
.odysseus-root .od-tasks-toolbar-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background: none;
  border: 1px solid var(--border);
  color: color-mix(in srgb, var(--fg) 60%, transparent);
  font-size: 11px;
  height: 24px;
  padding: 0 8px;
  border-radius: 6px;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
  white-space: nowrap;
}
.odysseus-root .od-tasks-toolbar-btn:hover:not(:disabled) {
  border-color: var(--fg);
  color: var(--fg);
}
.odysseus-root .od-tasks-toolbar-btn.active {
  background: color-mix(in srgb, var(--red) 15%, transparent);
  border-color: color-mix(in srgb, var(--red) 40%, transparent);
  color: var(--red);
}
.odysseus-root .od-tasks-toolbar-btn.danger {
  color: var(--red);
  border-color: color-mix(in srgb, var(--red) 40%, transparent);
}
.odysseus-root .od-tasks-toolbar-btn.danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--red) 10%, transparent);
}
.odysseus-root .od-tasks-toolbar-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.odysseus-root .od-tasks-headrow .od-tasks-toolbar-btn { margin-left: auto; }

.odysseus-root .od-tasks-sort {
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: inherit;
  font-size: 11px;
  height: 24px;
  padding: 0 6px;
  cursor: pointer;
  width: 86px;
}
.odysseus-root .od-tasks-sort:focus { outline: none; border-color: var(--red); }

.odysseus-root .od-tasks-search {
  height: 24px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--fg);
  font-family: inherit;
  font-size: 11px;
  width: 100%;
  box-sizing: border-box;
}
.odysseus-root .od-tasks-search:focus { outline: none; border-color: var(--red); }
.odysseus-root .od-tasks-search::placeholder {
  color: color-mix(in srgb, var(--fg) 40%, transparent);
}

/* Bulk-select bar (.memory-bulk-bar) */
.odysseus-root .od-tasks-bulk-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 18px 6px 2px;
  margin-bottom: 8px;
  border: 1px solid color-mix(in srgb, var(--red) 30%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--red) 5%, transparent);
  font-size: 11px;
}
.odysseus-root .od-tasks-bulk-all {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.odysseus-root .od-tasks-bulk-count { color: color-mix(in srgb, var(--fg) 70%, transparent); }
.odysseus-root .od-tasks-bulk-delete { margin-left: auto; }
.odysseus-root .od-tasks-bulk-cancel { padding: 3px 6px; }

/* Category filter chips (.memory-cat-chip) */
.odysseus-root .od-tasks-chips {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.odysseus-root .od-tasks-chip {
  background: none;
  border: 1px solid var(--border);
  color: color-mix(in srgb, var(--fg) 60%, transparent);
  font-size: 10px;
  height: 22px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  border-radius: 10px;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
  text-transform: lowercase;
}
.odysseus-root .od-tasks-chip:hover { border-color: var(--red); color: var(--red); }
.odysseus-root .od-tasks-chip.active {
  background: color-mix(in srgb, var(--red) 15%, transparent);
  border-color: color-mix(in srgb, var(--red) 40%, transparent);
  color: var(--red);
}

/* List (.memory-list) */
.odysseus-root .od-tasks-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.odysseus-root .od-tasks-empty {
  opacity: 0.4;
  font-size: 12px;
  text-align: center;
  padding: 24px 12px;
  line-height: 1.5;
}

/* Task card (.memory-item.task-card) */
.odysseus-root .od-tasks-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--fg) 3%, transparent);
  max-height: 200px;
  flex-shrink: 0;
  transition: all 0.15s;
}
.odysseus-root .od-tasks-item:hover {
  background: color-mix(in srgb, var(--fg) 5%, transparent);
  border-color: color-mix(in srgb, var(--fg) 16%, transparent);
}
.odysseus-root .od-tasks-item.selected {
  border-color: color-mix(in srgb, var(--red) 45%, transparent);
  background: color-mix(in srgb, var(--red) 6%, transparent);
}
/* paused: dim + saturate-down + diagonal hatch (.memory-item.task-paused) */
.odysseus-root .od-tasks-item.task-paused {
  opacity: 0.45;
  filter: saturate(0.55);
  background: repeating-linear-gradient(
    45deg,
    color-mix(in srgb, var(--fg) 2%, transparent),
    color-mix(in srgb, var(--fg) 2%, transparent) 8px,
    color-mix(in srgb, var(--fg) 5%, transparent) 8px,
    color-mix(in srgb, var(--fg) 5%, transparent) 16px
  );
}
.odysseus-root .od-tasks-item.task-paused:hover { opacity: 0.85; filter: saturate(0.9); }

.odysseus-root .od-tasks-item-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.odysseus-root .od-tasks-item-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.odysseus-root .od-tasks-item-icon {
  display: inline-flex;
  opacity: 0.4;
  flex-shrink: 0;
}
.odysseus-root .od-tasks-item-title {
  font-size: 12px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.odysseus-root .od-tasks-item-flex { flex: 1; }

/* Status badges (.task-status-badge + variants) */
.odysseus-root .od-tasks-status-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  padding: 1px 6px;
  border-radius: 3px;
  flex-shrink: 0;
  cursor: pointer;
  border: 1px solid transparent;
  line-height: 16px;
  font-family: inherit;
  transition: transform 0.12s ease, border-color 0.12s ease, background 0.12s ease, filter 0.12s ease;
  user-select: none;
}
.odysseus-root button.od-tasks-status-badge { appearance: none; }
.odysseus-root .od-tasks-status-badge:hover { filter: brightness(1.08) saturate(1.15); }
.odysseus-root .od-tasks-paused-badge {
  color: var(--orange, #ffb86c);
  background: color-mix(in srgb, var(--orange, #ffb86c) 22%, transparent);
  border-color: color-mix(in srgb, var(--orange, #ffb86c) 35%, transparent);
}
.odysseus-root .od-tasks-paused-badge:hover {
  background: color-mix(in srgb, var(--orange, #ffb86c) 30%, transparent);
  border-color: color-mix(in srgb, var(--orange, #ffb86c) 55%, transparent);
}
.odysseus-root .od-tasks-active-badge {
  color: var(--ok, #50fa7b);
  background: color-mix(in srgb, var(--ok, #50fa7b) 20%, transparent);
  border-color: color-mix(in srgb, var(--ok, #50fa7b) 35%, transparent);
}
.odysseus-root .od-tasks-active-badge:hover {
  background: color-mix(in srgb, var(--ok, #50fa7b) 28%, transparent);
  border-color: color-mix(in srgb, var(--ok, #50fa7b) 55%, transparent);
}
.odysseus-root .od-tasks-error-badge {
  color: var(--red);
  background: color-mix(in srgb, var(--red) 16%, transparent);
  border-color: color-mix(in srgb, var(--red) 34%, transparent);
  cursor: default;
}
.odysseus-root .od-tasks-done-badge {
  color: color-mix(in srgb, var(--fg) 55%, transparent);
  background: color-mix(in srgb, var(--fg) 8%, transparent);
  border-color: color-mix(in srgb, var(--fg) 18%, transparent);
  cursor: default;
}
.odysseus-root .od-tasks-run-badge {
  color: var(--accent, var(--red));
  background: color-mix(in srgb, var(--accent, var(--red)) 16%, transparent);
  border-color: color-mix(in srgb, var(--accent, var(--red)) 34%, transparent);
}
.odysseus-root .od-tasks-run-badge:hover {
  background: color-mix(in srgb, var(--accent, var(--red)) 24%, transparent);
  border-color: color-mix(in srgb, var(--accent, var(--red)) 52%, transparent);
}

/* Card actions (.memory-item-actions) — reveal on hover */
.odysseus-root .od-tasks-item-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s;
}
.odysseus-root .od-tasks-item:hover .od-tasks-item-actions,
.odysseus-root .od-tasks-item.expanded .od-tasks-item-actions { opacity: 1; }
.odysseus-root .od-tasks-menu-wrap { position: relative; }
.odysseus-root .od-tasks-menu-btn {
  background: none;
  border: 1px solid transparent;
  color: color-mix(in srgb, var(--fg) 55%, transparent);
  height: 22px;
  padding: 0 4px;
  border-radius: 6px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  transition: all 0.15s;
}
.odysseus-root .od-tasks-menu-btn:hover {
  color: var(--fg);
  border-color: var(--border);
  background: color-mix(in srgb, var(--fg) 6%, transparent);
}
.odysseus-root .od-tasks-menu {
  position: absolute;
  top: 100%;
  right: 0;
  z-index: 5;
  margin-top: 4px;
  min-width: 130px;
  display: flex;
  flex-direction: column;
  padding: 4px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 6px 18px color-mix(in srgb, #000 35%, transparent);
}
.odysseus-root .od-tasks-menu-item {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  background: none;
  border: none;
  color: var(--fg);
  font-family: inherit;
  font-size: 11px;
  text-align: left;
  padding: 5px 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.12s;
}
.odysseus-root .od-tasks-menu-item:hover { background: color-mix(in srgb, var(--fg) 8%, transparent); }
.odysseus-root .od-tasks-menu-item.danger { color: var(--red); }
.odysseus-root .od-tasks-menu-item.danger:hover { background: color-mix(in srgb, var(--red) 12%, transparent); }

/* Select checkbox (.memory-select-cb) — 6px round dot */
.odysseus-root .od-tasks-select-cb {
  -webkit-appearance: none;
  appearance: none;
  width: 6px; height: 6px;
  min-width: 6px; min-height: 6px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: transparent;
  cursor: pointer;
  flex-shrink: 0;
  margin: 0;
  box-sizing: content-box;
  transition: all 0.15s;
}
.odysseus-root .od-tasks-select-cb:hover { border-color: var(--red); }
.odysseus-root .od-tasks-select-cb:checked { background: var(--red); border-color: var(--red); }

/* Slim meta line + expandable detail */
.odysseus-root .od-tasks-item-meta {
  font-size: 10px;
  opacity: 0.4;
  margin-top: -1px;
}
.odysseus-root .od-tasks-item-detail {
  margin-top: 7px;
  padding: 8px 0 2px;
  border-top: 1px solid var(--border);
}
.odysseus-root .od-tasks-item-detail-meta {
  font-size: 10px;
  opacity: 0.4;
  margin-bottom: 6px;
}
.odysseus-root .od-tasks-item-result {
  font-size: 11px;
  margin-bottom: 6px;
  padding: 4px 8px;
  border-left: 2px solid var(--ok, #50fa7b);
  background: color-mix(in srgb, var(--ok, #50fa7b) 8%, transparent);
  border-radius: 2px;
  line-height: 1.4;
}
.odysseus-root .od-tasks-item-result.error {
  border-left-color: var(--red);
  background: color-mix(in srgb, var(--red) 8%, transparent);
}
.odysseus-root .od-tasks-item-result-mark { font-weight: 600; color: var(--ok, #50fa7b); }
.odysseus-root .od-tasks-item-result.error .od-tasks-item-result-mark { color: var(--red); }
.odysseus-root .od-tasks-item-result-text { opacity: 0.9; }
.odysseus-root .od-tasks-item-desc {
  font-size: 11px;
  opacity: 0.6;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}

/* "Add" tab placeholder */
.odysseus-root .od-tasks-add-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 32px 16px;
  opacity: 0.4;
  font-size: 12px;
  text-align: center;
}

/* Run-history sub-view (.task-history-header / .task-runs-list / .task-run-item) */
.odysseus-root .od-tasks-history-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.odysseus-root .od-tasks-history-title { font-size: 13px; opacity: 0.7; }
.odysseus-root .od-tasks-btn {
  font-family: inherit;
  font-size: 11px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: none;
  color: var(--fg);
  cursor: pointer;
  opacity: 0.7;
  transition: opacity 0.15s, background 0.15s;
}
.odysseus-root .od-tasks-btn:hover { opacity: 1; }
.odysseus-root .od-tasks-runs-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.odysseus-root .od-tasks-run-item {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
}
.odysseus-root .od-tasks-run-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}
.odysseus-root .od-tasks-run-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.odysseus-root .od-tasks-run-time { margin-left: auto; font-size: 10px; opacity: 0.45; }
.odysseus-root .od-tasks-run-result {
  font-size: 11px;
  opacity: 0.6;
  margin-top: 4px;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
}

/* Live clock footer (.tasks-clock) */
.odysseus-root .od-tasks-clock {
  font-size: 10px;
  opacity: 0.35;
  text-align: center;
  padding: 6px 0 2px;
  flex-shrink: 0;
}


/* ===== GalleryEditorView ===== */
/* ════════════════════════════════════════════════════════════════════
   Gallery Editor (odysseus galleryEditor.js + editor/* + editor rules in
   style.css). Scoped under .odysseus-root, colors via theme vars. Ported
   1:1 from odysseus's .gallery-editor / .ge-* rules. Reuses the shared
   .od-search-overlay / .od-search-backdrop backdrop pattern (CompareView)
   with a large full-bleed .od-ge-panel.
   ════════════════════════════════════════════════════════════════════ */

/* Full-bleed editor panel — large column reusing the overlay backdrop,
   same convention as .od-compare-panel. */
.odysseus-root .od-ge-panel {
  width: min(1280px, 97vw);
  height: min(90vh, 920px);
  max-width: none;
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
  animation: od-ge-enter 0.3s ease-out;
}
@keyframes od-ge-enter {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.odysseus-root .gallery-editor {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  height: 100%;
  overflow: hidden;
}

/* ── Top bar ── */
.odysseus-root .ge-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  gap: 8px;
  position: relative;
  z-index: 5;
}
.odysseus-root .ge-topbar-left,
.odysseus-root .ge-topbar-right {
  display: flex;
  align-items: center;
  gap: 4px;
}
.odysseus-root .ge-alpha-badge {
  flex-shrink: 0;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.1em;
  line-height: 1;
  padding: 3px 6px;
  margin-right: 4px;
  border-radius: 4px;
  color: var(--accent, var(--red));
  background: color-mix(in srgb, var(--accent, var(--red)) 16%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent, var(--red)) 40%, transparent);
  text-transform: uppercase;
  user-select: none;
  cursor: default;
}
.odysseus-root .ge-topbar-sep {
  width: 1px;
  height: 16px;
  background: var(--border);
  margin: 0 4px;
}
.odysseus-root .ge-ge-close {
  background: none;
  border: none;
  color: var(--muted, var(--fg));
  cursor: pointer;
  padding: 4px;
  margin-left: 2px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0.7;
  transition: opacity 0.15s, background 0.15s, color 0.15s;
}
.odysseus-root .ge-ge-close:hover {
  opacity: 1;
  color: var(--fg);
  background: color-mix(in srgb, var(--fg) 10%, transparent);
}

/* Topbar buttons sit visually 2px low against label baselines. */
.odysseus-root .ge-topbar .ge-btn,
.odysseus-root .ge-topbar .ge-btn-sm,
.odysseus-root .ge-topbar select { position: relative; top: -2px; }

/* Stacked button — glyph over a small uppercase label (Undo/Redo/Hist). */
.odysseus-root .ge-stacked-btn {
  display: inline-flex !important;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  padding: 2px 8px !important;
  line-height: 1;
}
.odysseus-root .ge-stacked-btn .ge-stacked-glyph {
  font-size: 14px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 14px;
}
.odysseus-root .ge-stacked-btn .ge-stacked-glyph svg { display: block; }
.odysseus-root .ge-stacked-btn .ge-stacked-label {
  font-size: 8px;
  letter-spacing: 0.06em;
  opacity: 0.65;
  font-weight: 600;
  position: relative;
  top: 2px;
}
.odysseus-root .ge-zoom-stack {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  line-height: 1;
  padding: 0 4px;
}
.odysseus-root .ge-zoom-stack .ge-zoom-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0.7;
  position: relative;
  left: -1px;
}
.odysseus-root .ge-zoom-stack .ge-zoom-glyph svg { width: 16px; height: 16px; }
.odysseus-root .ge-zoom-stack .ge-zoom-label {
  font-size: 8px;
  letter-spacing: 0.06em;
  opacity: 0.65;
  font-weight: 600;
  position: relative;
  top: 4px;
  left: 1px;
}

/* Topbar dropdown menus (Image / Filter / Save). */
.odysseus-root .ge-image-wrap,
.odysseus-root .ge-filter-wrap,
.odysseus-root .ge-save-wrap { position: relative; display: inline-block; }
.odysseus-root .ge-image-menu,
.odysseus-root .ge-filter-menu,
.odysseus-root .ge-save-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  min-width: 160px;
  padding: 4px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 4px 14px color-mix(in srgb, var(--fg) 18%, transparent);
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.odysseus-root .ge-save-menu-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.odysseus-root .ge-image-menu .dropdown-item-compact,
.odysseus-root .ge-filter-menu .dropdown-item-compact,
.odysseus-root .ge-save-menu .dropdown-item-compact {
  width: 100%;
  background: none;
  border: none;
  text-align: left;
  font: inherit;
  font-size: 11px;
  color: var(--fg);
  border-radius: 5px;
  padding: 5px 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
}
.odysseus-root .ge-image-menu .dropdown-item-compact:hover,
.odysseus-root .ge-filter-menu .dropdown-item-compact:hover,
.odysseus-root .ge-save-menu .dropdown-item-compact:hover {
  background: color-mix(in srgb, var(--fg) 12%, transparent);
}
.odysseus-root .ge-image-menu .dropdown-icon,
.odysseus-root .ge-filter-menu .dropdown-icon,
.odysseus-root .ge-save-menu .dropdown-icon {
  display: inline-flex;
  align-items: center;
  color: var(--muted, var(--fg));
  flex-shrink: 0;
  width: 14px;
  justify-content: center;
}
.odysseus-root .dropdown-shortcut {
  margin-left: auto;
  font-size: 9px;
  opacity: 0.5;
  font-variant-numeric: tabular-nums;
}
.odysseus-root .ge-filter-submenu-label,
.odysseus-root .dropdown-section-label {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  opacity: 0.5;
  font-weight: 600;
  padding: 6px 8px 2px;
}
.odysseus-root .dropdown-section-divider {
  height: 1px;
  background: var(--border);
  margin: 4px 0;
  opacity: 0.6;
}

/* ── Editor body (toolbar + canvas + panel) ── */
.odysseus-root .ge-editor-body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  position: relative;
}

/* ── Left tool palette ── */
.odysseus-root .ge-toolbar {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 8px 8px 0;
  background: var(--panel);
  border-right: 1px solid var(--border);
  width: 56px;
  flex-shrink: 0;
  overflow-y: auto;
}
.odysseus-root .ge-tool-sep {
  border-top: 1px solid var(--border);
  margin: 4px 0;
  opacity: 0.6;
  flex-shrink: 0;
}
.odysseus-root .ge-tool-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 0 2px;
  height: 42px;
  flex-shrink: 0;
  border: none;
  background: none;
  color: var(--fg);
  opacity: 0.6;
  cursor: pointer;
  border-radius: 6px;
  transition: background 0.15s, opacity 0.15s;
  position: relative;
}
.odysseus-root .ge-tool-btn:hover { opacity: 0.85; }
.odysseus-root .ge-tool-btn:hover::after {
  content: '';
  position: absolute;
  inset: 0 2px 0 -2px;
  background: color-mix(in srgb, var(--fg) 8%, transparent);
  border-radius: 6px;
  z-index: -1;
  pointer-events: none;
}
.odysseus-root .ge-tool-btn.active {
  opacity: 1;
  color: var(--red);
  background: none;
}
.odysseus-root .ge-tool-btn.active::before {
  content: '';
  position: absolute;
  inset: 0 2px 0 -2px;
  background: color-mix(in srgb, var(--red) 18%, transparent);
  border-radius: 6px;
  z-index: 0;
  pointer-events: none;
}
.odysseus-root .ge-tool-btn > * { position: relative; z-index: 1; left: -2px; }
.odysseus-root .ge-tool-icon {
  font-size: 18px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.odysseus-root .ge-tool-glyph { font-size: 18px; line-height: 1; }
.odysseus-root .ge-tool-label {
  font-size: 9px;
  line-height: 1.25;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.odysseus-root .ge-tool-ai {
  position: absolute !important;
  top: 1px;
  left: 3px !important;
  z-index: 2;
  color: inherit;
  opacity: 0.7;
  pointer-events: none;
  font-size: 11px;
  line-height: 1;
  font-weight: 700;
}
.odysseus-root .ge-tool-btn.is-ai:hover .ge-tool-ai { opacity: 0.95; }
.odysseus-root .ge-tool-btn.is-ai.active .ge-tool-ai { opacity: 1; }

/* ── Canvas area (center) + checkerboard + honest landing ── */
.odysseus-root .ge-canvas-area {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: auto;
  background: var(--bg);
  position: relative;
  min-width: 0;
}
.odysseus-root .gallery-editor-landing {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 64px 16px;
  flex: 1;
  text-align: center;
  color: var(--fg);
  /* Checkerboard transparency backdrop framed like odysseus's canvas. */
  width: min(520px, 72%);
  aspect-ratio: 4 / 3;
  max-height: 80%;
  border-radius: 8px;
  background:
    repeating-conic-gradient(
      color-mix(in srgb, var(--fg) 8%, transparent) 0% 25%,
      color-mix(in srgb, var(--fg) 3%, transparent) 0% 50%
    ) 50% / 22px 22px;
  border: 1px dashed color-mix(in srgb, var(--fg) 20%, transparent);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.18);
}
.odysseus-root .gallery-editor-landing h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
.odysseus-root .gallery-editor-landing p {
  margin: 0;
  opacity: 0.6;
  font-size: 13px;
  max-width: 320px;
  line-height: 1.5;
}
.odysseus-root .ge-alpha-tag {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  vertical-align: middle;
  padding: 1px 5px;
  border-radius: 4px;
  color: var(--accent, var(--red));
  background: color-mix(in srgb, var(--accent, var(--red)) 15%, transparent);
  position: relative;
  top: -1px;
}
.odysseus-root .gallery-editor-landing-actions {
  display: flex;
  gap: 10px;
  margin-top: 8px;
}
.odysseus-root .ge-ge-landing-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 16px;
  font-size: 12px;
}
.odysseus-root .ge-ge-landing-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ── Right panel (controls + layers) ── */
.odysseus-root .ge-right-panel {
  width: 220px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--border);
  background: var(--panel);
  overflow-y: auto;
  overflow-x: hidden;
  position: relative;
}
.odysseus-root .ge-controls {
  flex: 0 0 auto;
  padding: 10px 10px 6px;
  border-bottom: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.odysseus-root .ge-brush-controls {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.odysseus-root .ge-controls input[type="range"] {
  width: 100%;
  box-sizing: border-box;
  margin: 0;
  display: block;
}
.odysseus-root .ge-control-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--fg);
}
.odysseus-root .ge-control-row label {
  flex-shrink: 0;
  opacity: 0.7;
  min-width: 36px;
}
.odysseus-root .ge-color-picker {
  width: 24px;
  height: 24px;
  border: 1px solid var(--border);
  border-radius: 50%;
  padding: 0;
  cursor: pointer;
  background: none;
  overflow: hidden;
  flex: 0 0 24px;
}
.odysseus-root .ge-color-picker::-webkit-color-swatch-wrapper { padding: 0; }
.odysseus-root .ge-color-picker::-webkit-color-swatch { border: none; border-radius: 50%; }
.odysseus-root .ge-color-picker::-moz-color-swatch { border: none; border-radius: 50%; }

/* Section titles / hints / dividers / help chip. */
.odysseus-root .ge-section-title {
  margin: 10px 0 4px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  opacity: 0.5;
  font-weight: 600;
}
.odysseus-root .ge-section-title-with-help {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.odysseus-root .ge-ge-mask-brush-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}
.odysseus-root .ge-section-hint {
  font-size: 10.5px;
  line-height: 1.45;
  opacity: 0.55;
  margin: 0 0 8px;
}
.odysseus-root .ge-ge-tiny-hint {
  font-size: 9px;
  opacity: 0.4;
  margin: 4px 0 0;
}
.odysseus-root .ge-section-divider {
  border: 0;
  border-top: 1px solid var(--border);
  margin: 10px -2px;
  opacity: 0.6;
}
.odysseus-root .ge-section-help {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin-left: 4px;
  font-size: 9px;
  font-weight: 600;
  border: 1px solid var(--border);
  border-radius: 50%;
  color: var(--muted, var(--fg));
  background: none;
  cursor: help;
  position: relative;
  top: -1px;
  opacity: 0.7;
  transition: opacity 0.15s, color 0.15s, border-color 0.15s;
}
.odysseus-root .ge-section-title-with-help .ge-section-help { margin-left: 0; }
.odysseus-root .ge-section-help:hover {
  opacity: 1;
  color: var(--fg);
  border-color: var(--muted, var(--fg));
}

/* Slider rows (Opacity / Flow / Softness / Tolerance / Strength / …). */
.odysseus-root .ge-eraser-row {
  display: flex !important;
  align-items: center !important;
  gap: 8px;
  padding: 2px 0;
  position: relative;
}
.odysseus-root .ge-eraser-row label {
  font-size: 10px;
  opacity: 0.55;
  flex: 0 0 78px;
  white-space: nowrap;
}
.odysseus-root .ge-eraser-row input[type="range"] {
  flex: 1 1 auto;
  min-width: 0;
  height: 8px;
  accent-color: var(--red);
  -webkit-appearance: none;
  appearance: none;
  background: color-mix(in srgb, var(--fg) 25%, transparent);
  border-radius: 999px;
  margin: 0;
  position: relative;
  z-index: 2;
}
.odysseus-root .ge-eraser-row input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--red);
  border: none;
  cursor: pointer;
}
.odysseus-root .ge-eraser-row input[type="range"]::-moz-range-thumb {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--red);
  border: none;
  cursor: pointer;
}
.odysseus-root .ge-slider-value {
  flex: 0 0 auto;
  margin: 0 0 0 6px;
  padding: 0 4px;
  font-size: 10px;
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
  min-width: 34px;
  text-align: right;
  white-space: nowrap;
}
.odysseus-root .ge-eraser-preview {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--fg);
  flex-shrink: 0;
  display: inline-block;
  opacity: 0.5;
}

/* Size slider in the brush-controls block (no preview disk). */
.odysseus-root .ge-size-slider {
  flex: 1 1 auto;
  height: 8px;
  accent-color: var(--red);
  -webkit-appearance: none;
  appearance: none;
  background: color-mix(in srgb, var(--fg) 25%, transparent);
  border-radius: 999px;
}
.odysseus-root .ge-size-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--red);
  border: none;
  cursor: pointer;
}
.odysseus-root .ge-size-slider::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--red);
  border: none;
  cursor: pointer;
}
.odysseus-root .ge-size-label {
  margin-left: 4px;
  padding: 0 4px;
  font-size: 10px;
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
}

/* Action button clusters. */
.odysseus-root .ge-actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.odysseus-root .ge-ge-actions-wrap { margin-top: 4px; }
.odysseus-root .ge-ge-mode-row { display: flex; gap: 4px; margin-bottom: 4px; }
.odysseus-root .ge-ge-model-row { margin-top: 6px; }
.odysseus-root .ge-ge-strength-row { margin-top: 6px; }
.odysseus-root .ge-ge-ai-actions {
  margin-top: 6px;
  display: flex;
  gap: 6px;
  align-items: center;
  min-width: 0;
}
.odysseus-root .ge-ge-ai-btn { flex: 1 1 0; }
.odysseus-root .ge-ge-ai-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.odysseus-root .ge-ge-mode-half {
  flex: 1 1 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}

/* Base buttons. */
.odysseus-root .ge-btn {
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--fg);
  font-size: 11px;
  cursor: pointer;
  transition: background 0.15s;
}
.odysseus-root .ge-btn:hover { background: color-mix(in srgb, var(--fg) 10%, var(--bg)); }
.odysseus-root .ge-btn.active {
  background: color-mix(in srgb, var(--accent, var(--red)) 16%, var(--bg));
  border-color: var(--accent, var(--red));
  color: var(--accent, var(--red));
}
.odysseus-root .ge-btn-sm { padding: 3px 6px; font-size: 10px; }
.odysseus-root .ge-btn-iconlabel {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.odysseus-root .ge-btn-primary {
  background: var(--red);
  color: #fff;
  border-color: var(--red);
  font-weight: 600;
}
.odysseus-root .ge-btn-primary:hover { background: color-mix(in srgb, var(--red) 85%, #000); }
.odysseus-root .ge-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.odysseus-root .ge-btn-ai-mark {
  display: inline-block;
  font-size: 11px;
  line-height: 1;
  font-weight: 700;
  opacity: 0.75;
  margin-right: 1px;
}
.odysseus-root .ge-mask-vis-btn {
  background: none !important;
  border: none !important;
  padding: 2px 4px !important;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  opacity: 0.5;
  transition: opacity 0.12s;
}
.odysseus-root .ge-mask-vis-btn.visible { opacity: 0.9; }
.odysseus-root .ge-mask-vis-btn:hover { opacity: 1; background: none !important; }
.odysseus-root .ge-inpaint-mode-btn,
.odysseus-root .ge-wand-mode-btn {
  font-size: 11px;
  padding: 4px 8px;
  opacity: 0.6;
  border: 1px solid var(--border);
}
.odysseus-root .ge-wand-mode-btn { flex: 1 1 0; padding: 4px 6px; }
.odysseus-root .ge-inpaint-mode-btn.active,
.odysseus-root .ge-wand-mode-btn.active {
  opacity: 1;
  background: color-mix(in srgb, var(--accent, var(--red)) 18%, transparent);
  border-color: var(--accent, var(--red));
  color: var(--accent, var(--red));
  font-weight: 600;
}

/* Inpaint section bits. */
.odysseus-root .ge-inpaint-section {
  padding: 8px 0;
  border-top: 1px solid var(--border);
  margin-top: 4px;
}
.odysseus-root .ge-inpaint-mask-row {
  display: flex !important;
  gap: 4px;
  align-items: center;
  margin-top: 4px;
}
.odysseus-root .ge-inpaint-prompt {
  width: 100%;
  padding: 6px 8px;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 12px;
  font-family: inherit;
  margin-top: 4px;
  box-sizing: border-box;
}
.odysseus-root .ge-inpaint-prompt:focus { border-color: var(--red); outline: none; }
.odysseus-root .ge-inpaint-model-row { display: flex; align-items: center; gap: 8px; }
.odysseus-root .ge-inpaint-model-row label { flex: 0 0 auto; font-size: 10px; opacity: 0.65; }
.odysseus-root .ge-ai-model {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 10px;
  padding: 4px 6px;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 4px;
}

/* ── Layers panel ── */
.odysseus-root .ge-layers {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
}
.odysseus-root .ge-layers-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 11px;
  font-weight: 600;
  color: var(--fg);
  opacity: 0.8;
  border-bottom: 1px solid var(--border);
}
.odysseus-root .ge-layers-title { flex: 1; }
.odysseus-root .ge-layers-grab { display: none; }
.odysseus-root .ge-icon-btn {
  padding: 4px 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.odysseus-root .ge-layers-header .ge-btn:disabled,
.odysseus-root .ge-ge-add-layer:disabled { opacity: 0.4; cursor: not-allowed; }
.odysseus-root .ge-layers-list {
  max-height: 320px;
  overflow-y: auto;
  padding: 0;
}
.odysseus-root .ge-ge-layers-empty {
  padding: 18px 12px;
  font-size: 11px;
  text-align: center;
  opacity: 0.5;
  line-height: 1.5;
}

/* Panel resize grab handle. */
.odysseus-root .ge-panel-resize {
  position: absolute;
  left: -3px;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: ew-resize;
  background: transparent;
  z-index: 5;
  transition: background 0.12s;
}
.odysseus-root .ge-panel-resize:hover {
  background: color-mix(in srgb, var(--red) 30%, transparent);
}
.odysseus-root .ge-panel-resize::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 2px;
  height: 24px;
  background: color-mix(in srgb, var(--fg) 35%, transparent);
  border-radius: 2px;
}

/* ── History popover (frosted) ── */
.odysseus-root .ge-frosted {
  background: color-mix(in srgb, var(--panel) 70%, transparent);
  backdrop-filter: blur(14px) saturate(140%);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
  border: 1px solid color-mix(in srgb, var(--fg) 12%, transparent);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
}
.odysseus-root .ge-history-panel {
  position: absolute;
  top: 52px;
  left: 92px;
  z-index: 60;
  width: 240px;
  max-height: 360px;
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  color: var(--fg);
}
.odysseus-root .ge-history-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--fg) 10%, transparent);
}
.odysseus-root .ge-adj-icon {
  display: inline-flex;
  align-items: center;
  color: var(--muted, var(--fg));
  flex-shrink: 0;
}
.odysseus-root .ge-history-title { font-weight: 600; font-size: 12px; flex: 1 1 auto; }
.odysseus-root .ge-head-btns { display: inline-flex; margin-left: auto; }
.odysseus-root .ge-history-close {
  background: none;
  border: none;
  color: var(--muted, var(--fg));
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 0 4px;
  flex-shrink: 0;
}
.odysseus-root .ge-history-close:hover { color: var(--fg); }
.odysseus-root .ge-history-list { overflow-y: auto; padding: 4px 0; }
.odysseus-root .ge-history-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 10px;
  background: none;
  border: none;
  text-align: left;
  cursor: pointer;
  color: var(--fg);
  font-size: 11px;
}
.odysseus-root .ge-history-row:hover { background: color-mix(in srgb, var(--fg) 8%, transparent); }
.odysseus-root .ge-history-row.current {
  background: color-mix(in srgb, var(--accent, var(--red)) 18%, transparent);
}
.odysseus-root .ge-history-row.current .ge-history-row-dot { background: var(--accent, var(--red)); }
.odysseus-root .ge-history-row-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--muted, var(--fg));
  flex-shrink: 0;
}
.odysseus-root .ge-history-row-label {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.odysseus-root .ge-history-row-time { font-size: 9px; opacity: 0.55; flex-shrink: 0; }

/* ── Shortcuts cheatsheet overlay ── */
.odysseus-root .ge-shortcuts-overlay {
  position: absolute;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: center;
  justify-content: center;
}
.odysseus-root .ge-shortcuts-card {
  position: relative;
  z-index: 1;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 18px 12px;
  box-shadow: 0 8px 30px color-mix(in srgb, var(--fg) 25%, transparent);
  width: min(720px, 92%);
  max-height: 86%;
  overflow-y: auto;
  color: var(--fg);
}
.odysseus-root .ge-shortcuts-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  font-weight: 600;
  font-size: 13px;
}
.odysseus-root .ge-shortcuts-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 14px 24px;
}
@media (min-width: 720px) {
  .odysseus-root .ge-shortcuts-grid { grid-template-columns: repeat(4, 1fr); }
}
.odysseus-root .ge-shortcuts-col h5 {
  margin: 0 0 6px;
  font-size: 11px;
  opacity: 0.6;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: 600;
}
.odysseus-root .ge-shortcuts-col > div {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  padding: 4px 0;
  opacity: 0.85;
  line-height: 1.5;
}
.odysseus-root .ge-shortcuts-col > div kbd:last-of-type { margin-right: 6px; }
.odysseus-root .ge-shortcuts-card kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border: 1px solid color-mix(in srgb, var(--accent, var(--red)) 55%, transparent);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--accent, var(--red)) 14%, transparent);
  color: var(--accent, var(--red));
  min-width: 18px;
  line-height: 1.4;
}
.odysseus-root .ge-shortcuts-foot {
  margin-top: 12px;
  font-size: 11px;
  opacity: 0.55;
  text-align: center;
}
/* ===== GroupChatView ===== */
/* ── Group Chat (odysseus group.js + .msg-group rules) ──────────────────────
   A wide panel: header with a participant count + parallel/sequential mode
   toggle + close, a room picker, then a two-column body (participant roster +
   shared message stream) above a composer. Reuses the shared .od-msg /
   .od-role / .od-body / .od-msg-time bubble styles already in ODYSSEUS_CSS; the
   classes below are the group-specific chrome. All colours via theme vars. */
.odysseus-root .od-search-panel.od-group-panel {
  width: 860px;
  max-width: 94%;
  height: 80vh;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
}
.odysseus-root .od-group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.odysseus-root .od-group-header-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
}
.odysseus-root .od-group-header-count {
  font-size: 11px;
  font-weight: 400;
  color: color-mix(in srgb, var(--fg) 45%, transparent);
}
.odysseus-root .od-group-header-spacer { flex: 1; }
/* odysseus #group-mode-btn — icon + label, comfortable touch target. */
.odysseus-root .od-group-mode-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  font-size: 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--fg) 4%, transparent);
  color: var(--fg);
  cursor: pointer;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.odysseus-root .od-group-mode-btn:hover {
  background: color-mix(in srgb, var(--fg) 8%, transparent);
}
/* odysseus #group-toggle-btn.active — red wash when parallel ("all respond"). */
.odysseus-root .od-group-mode-btn.active {
  color: var(--red);
  background: color-mix(in srgb, var(--red) 12%, transparent);
  border-color: color-mix(in srgb, var(--red) 40%, transparent);
}
.odysseus-root .od-group-mode-label { font-size: 12px; font-weight: 500; }
.odysseus-root .od-group-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  border: none;
  background: none;
  color: color-mix(in srgb, var(--fg) 55%, transparent);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.odysseus-root .od-group-close:hover {
  background: color-mix(in srgb, var(--fg) 8%, transparent);
  color: var(--fg);
}
.odysseus-root .od-group-roompicker {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.odysseus-root .od-group-roompicker-label {
  font-size: 11px;
  font-weight: 600;
  color: color-mix(in srgb, var(--fg) 50%, transparent);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.odysseus-root .od-group-room-select {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  font-size: 12px;
  font-family: inherit;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--fg);
  outline: none;
  cursor: pointer;
}
.odysseus-root .od-group-room-select:focus { border-color: var(--accent, var(--red)); }
.odysseus-root .od-group-body {
  display: flex;
  flex: 1;
  min-height: 0;
}
/* ── Participant roster (odysseus group-participants list) ── */
.odysseus-root .od-group-roster {
  width: 210px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}
.odysseus-root .od-group-roster-head {
  padding: 10px 12px 6px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: color-mix(in srgb, var(--fg) 45%, transparent);
}
.odysseus-root .od-group-roster-empty {
  padding: 12px;
  font-size: 12px;
  color: color-mix(in srgb, var(--fg) 45%, transparent);
}
.odysseus-root .od-group-roster-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 6px 8px;
}
/* odysseus participant row: flex, color-mix bg, 6px radius. */
.odysseus-root .od-group-participant {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--fg) 3%, transparent);
}
.odysseus-root .od-group-participant.idle { opacity: 0.55; }
.odysseus-root .od-group-participant-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.odysseus-root .od-group-participant-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}
.odysseus-root .od-group-participant-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.odysseus-root .od-group-participant-sub {
  font-size: 10px;
  color: color-mix(in srgb, var(--fg) 38%, transparent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* ── Shared message stream ── */
.odysseus-root .od-group-stream-wrap {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.odysseus-root .od-group-stream {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: 12px 14px;
}
.odysseus-root .od-group-empty {
  margin: auto;
  max-width: 360px;
  text-align: center;
  font-size: 13px;
  line-height: 1.5;
  color: color-mix(in srgb, var(--fg) 45%, transparent);
}
/* odysseus .msg-group .role is bold; the per-sender dot/name/time mirror the
   group bubble header (role + role-timestamp). */
.odysseus-root .od-msg-group .od-role { font-weight: 600; }
.odysseus-root .od-group-role-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.odysseus-root .od-group-role-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.odysseus-root .od-group-role-time {
  font-size: 0.7rem;
  font-weight: 400;
  color: color-mix(in srgb, var(--fg) 45%, transparent);
  margin-left: 2px;
}
/* ── Composer (odysseus .chat-input-bar) ── */
.odysseus-root .od-group-composer {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}
.odysseus-root .od-group-input {
  flex: 1;
  min-height: 38px;
  max-height: 120px;
  resize: none;
  padding: 9px 11px;
  font-size: 13px;
  font-family: inherit;
  line-height: 1.4;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--input-bg, var(--bg));
  color: var(--fg);
  outline: none;
}
.odysseus-root .od-group-input:focus { border-color: var(--accent, var(--red)); }
.odysseus-root .od-group-input:disabled { opacity: 0.5; cursor: not-allowed; }
.odysseus-root .od-group-send {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  border-radius: 8px;
  border: none;
  background: var(--accent, var(--red));
  color: #fff;
  cursor: pointer;
  transition: filter 0.12s, opacity 0.12s;
}
.odysseus-root .od-group-send:hover:not(:disabled) { filter: brightness(1.1); }
.odysseus-root .od-group-send:disabled { opacity: 0.4; cursor: not-allowed; }
.odysseus-root .od-group-note {
  padding: 0 14px 10px;
  font-size: 11px;
  line-height: 1.4;
  color: color-mix(in srgb, var(--fg) 42%, transparent);
  flex-shrink: 0;
}
.odysseus-root .od-group-note strong { color: color-mix(in srgb, var(--fg) 70%, transparent); }
/* ===== AdminView ===== */
/* ════════════════════════════════════════════════════════════════════
   AdminView — odysseus admin panel (admin.js + index.html admin sub-tabs).
   All rules scoped under .odysseus-root; colors via theme vars only.
   Mirrors odysseus's .admin-card / .admin-switch / .admin-user-row /
   .admin-badge / .admin-btn-* / .admin-toggle-* / .admin-priv-* rules.
   ════════════════════════════════════════════════════════════════════ */

/* Full-bleed panel (sized like CompareView's .od-compare-panel) */
.odysseus-root .od-admin-panel {
  display: flex;
  flex-direction: column;
  width: min(900px, 94vw);
  height: min(86vh, 760px);
  max-height: 86vh;
  padding: 0;
  overflow: hidden;
}

/* ── Header (settings-modal header) ── */
.odysseus-root .od-admin-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.odysseus-root .od-admin-header-title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--fg);
}
.odysseus-root .od-admin-header-spacer { flex: 1; }
.odysseus-root .od-admin-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--fg);
  cursor: pointer;
  transition: all 0.15s;
}
.odysseus-root .od-admin-close:hover { background: var(--border); border-color: var(--red); }

/* ── Honest empty-state notice ── */
.odysseus-root .od-admin-notice {
  margin: 10px 14px 0;
  padding: 9px 12px;
  border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--fg) 4%, var(--panel));
  color: color-mix(in srgb, var(--fg) 70%, transparent);
  font-size: 11.5px;
  line-height: 1.5;
  flex-shrink: 0;
}

/* ── Body: left rail + panels ── */
.odysseus-root .od-admin-body {
  display: flex;
  flex: 1;
  min-height: 0;
  gap: 0;
}
.odysseus-root .od-admin-rail {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 178px;
  flex-shrink: 0;
  padding: 12px 10px;
  border-right: 1px solid var(--border);
  overflow-y: auto;
}
.odysseus-root .od-admin-rail-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
  opacity: 0.35;
  padding: 4px 8px 6px;
}
.odysseus-root .od-admin-rail-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 10px;
  border: none;
  border-radius: 7px;
  background: none;
  color: color-mix(in srgb, var(--fg) 75%, transparent);
  font-size: 13px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.odysseus-root .od-admin-rail-item:hover {
  background: color-mix(in srgb, var(--fg) 8%, transparent);
  color: var(--fg);
}
.odysseus-root .od-admin-rail-item.active {
  background: color-mix(in srgb, var(--accent, var(--red)) 14%, transparent);
  color: var(--fg);
}
.odysseus-root .od-admin-panels {
  flex: 1;
  min-width: 0;
  padding: 14px;
  overflow-y: auto;
}

/* ── Cards (admin-card) ── */
.odysseus-root .od-admin-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 10px;
}
.odysseus-root .od-admin-card-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.03em;
  margin: 0 0 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 40%, transparent);
  color: var(--fg);
}
.odysseus-root .od-admin-card-title svg { opacity: 0.6; flex-shrink: 0; }
.odysseus-root .od-admin-danger-card {
  border-color: color-mix(in srgb, var(--red) 27%, transparent);
}
.odysseus-root .od-admin-danger-title { color: var(--red); }
.odysseus-root .od-admin-danger-title svg { opacity: 1; }

/* ── Toggle rows (admin-toggle-*) ── */
.odysseus-root .od-admin-toggle-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.odysseus-root .od-admin-toggle-label { font-size: 13px; font-weight: 500; color: var(--fg); }
.odysseus-root .od-admin-toggle-sub {
  color: color-mix(in srgb, var(--fg) 50%, transparent);
  font-size: 11px;
  margin-top: 2px;
  line-height: 1.45;
}

/* ── Switch (admin-switch / admin-slider) ── */
.odysseus-root .od-admin-switch {
  position: relative;
  width: 30px;
  height: 16px;
  flex-shrink: 0;
  display: inline-block;
}
.odysseus-root .od-admin-switch-sm { transform: scale(0.85); }
.odysseus-root .od-admin-switch input { opacity: 0; width: 0; height: 0; }
.odysseus-root .od-admin-slider {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--fg) 50%, transparent);
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.08s;
}
.odysseus-root .od-admin-slider::before {
  content: '';
  position: absolute;
  left: 2px;
  top: 2px;
  width: 12px;
  height: 12px;
  background: var(--panel);
  border-radius: 50%;
  transition: transform 0.08s;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
}
.odysseus-root .od-admin-switch input:checked + .od-admin-slider { background: var(--red); }
.odysseus-root .od-admin-switch input:checked + .od-admin-slider::before { transform: translateX(14px); }
.odysseus-root .od-admin-switch input:disabled + .od-admin-slider { cursor: not-allowed; opacity: 0.6; }
.odysseus-root .od-admin-switch-inline {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: color-mix(in srgb, var(--fg) 60%, transparent);
}

/* ── User rows (admin-user-row) ── */
.odysseus-root .od-admin-empty {
  color: color-mix(in srgb, var(--fg) 45%, transparent);
  font-size: 12px;
  padding: 10px 4px;
  text-align: center;
}
.odysseus-root .od-admin-user-row {
  display: flex;
  flex-direction: column;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 6px;
  transition: border-color 0.15s;
}
.odysseus-root .od-admin-user-row:hover {
  border-color: color-mix(in srgb, var(--fg) 20%, var(--border));
}
.odysseus-root .od-admin-user-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  padding: 4px 0;
}
.odysseus-root .od-admin-user-info { display: flex; align-items: center; gap: 8px; }
.odysseus-root .od-admin-user-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--accent, var(--red)) 20%, var(--panel));
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
  color: var(--accent, var(--red));
}
.odysseus-root .od-admin-user-name { font-size: 13px; font-weight: 500; color: var(--fg); }
.odysseus-root .od-admin-user-hint { font-size: 10px; opacity: 0.4; display: block; }
.odysseus-root .od-admin-user-actions { display: flex; gap: 8px; align-items: center; }
.odysseus-root .od-admin-badge {
  font-size: 10px;
  padding: 2px 6px;
  margin-left: 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--red) 20%, transparent);
  color: var(--red);
  font-weight: 600;
}

/* ── Privilege panel (admin-priv-*) ── */
.odysseus-root .od-admin-priv-panel {
  max-height: 1200px;
  transition: max-height 0.3s ease, opacity 0.2s ease, padding 0.2s ease;
  overflow: hidden;
  padding: 8px 0 4px;
  border-top: 1px solid var(--border);
  margin-top: 8px;
}
.odysseus-root .od-admin-priv-panel.hidden {
  max-height: 0;
  opacity: 0;
  padding-top: 0;
  padding-bottom: 0;
  margin-top: 0;
  border-top: none;
}
.odysseus-root .od-admin-priv-section {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  opacity: 0.35;
  font-weight: 600;
  margin: 10px 0 4px;
}
.odysseus-root .od-admin-priv-section:first-child { margin-top: 0; }
.odysseus-root .od-admin-priv-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0;
}
.odysseus-root .od-admin-priv-label { font-size: 12px; color: var(--fg); }
.odysseus-root .od-admin-priv-hint {
  font-size: 10px;
  opacity: 0.4;
  margin-bottom: 4px;
}
.odysseus-root .od-admin-priv-num {
  width: 70px;
  padding: 4px 6px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--fg);
  font-size: 12px;
  text-align: center;
}
.odysseus-root .od-admin-priv-models-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 4px;
}
.odysseus-root .od-admin-priv-models-actions { display: flex; gap: 8px; font-size: 10px; opacity: 0.5; }
.odysseus-root .od-admin-priv-models-list {
  max-height: 150px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 6px;
  background: var(--bg);
}
.odysseus-root .od-admin-priv-models-empty { opacity: 0.4; font-size: 11px; }
.odysseus-root .od-admin-priv-model-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 3px 2px;
  font-size: 12px;
  color: var(--fg);
}
.odysseus-root .od-admin-priv-model-row input { accent-color: var(--accent, var(--red)); }

/* ── Buttons (admin-btn-*) ── */
.odysseus-root .od-admin-btn-add {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border: none;
  border-radius: 6px;
  background: var(--red);
  color: #fff;
  cursor: pointer;
  font-weight: 600;
  font-size: 11px;
  font-family: inherit;
  transition: all 0.15s;
}
.odysseus-root .od-admin-btn-add:hover:not(:disabled) {
  background: color-mix(in srgb, var(--red) 80%, white);
}
.odysseus-root .od-admin-btn-add:disabled { opacity: 0.5; cursor: not-allowed; }
.odysseus-root .od-admin-btn-delete {
  background: none;
  border: 1px solid color-mix(in srgb, var(--red) 27%, transparent);
  color: var(--red);
  padding: 4px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 11px;
  font-family: inherit;
  white-space: nowrap;
  transition: all 0.15s;
}
.odysseus-root .od-admin-btn-delete:hover:not(:disabled) {
  background: var(--red);
  border-color: var(--red);
  color: #fff;
}
.odysseus-root .od-admin-btn-delete:disabled { opacity: 0.5; cursor: not-allowed; }
.odysseus-root .od-admin-btn-sm {
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--fg);
  cursor: pointer;
  font-size: 11px;
  font-family: inherit;
}
.odysseus-root .od-admin-btn-sm:hover:not(:disabled) { background: var(--border); border-color: var(--red); }
.odysseus-root .od-admin-btn-sm:disabled { opacity: 0.5; cursor: not-allowed; }

/* ── Add-user form (admin-add-form) ── */
.odysseus-root .od-admin-add-form {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.odysseus-root .od-admin-add-form input[type="text"],
.odysseus-root .od-admin-add-form input[type="password"] {
  flex: 1;
  min-width: 120px;
  padding: 5px 8px;
  height: 32px;
  box-sizing: border-box;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--fg);
  font-family: inherit;
  font-size: 12px;
}
.odysseus-root .od-admin-add-form input:focus { outline: none; border-color: var(--red); }
.odysseus-root .od-admin-add-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}
.odysseus-root .od-admin-add-msg {
  font-size: 11px;
  color: color-mix(in srgb, var(--fg) 45%, transparent);
}

/* ── Feature list (Agent Tools) ── */
.odysseus-root .od-admin-feature-list { margin-top: 6px; }
.odysseus-root .od-admin-feature-row {
  padding: 0.4rem 0;
  border-bottom: 1px solid var(--border);
}
.odysseus-root .od-admin-feature-row:last-child { border-bottom: none; }

/* ── System tab (Backup + Danger Zone) ── */
.odysseus-root .od-admin-backup-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.odysseus-root .od-admin-wipe-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 8px;
  gap: 12px;
}
.odysseus-root .od-admin-wipe-row:first-of-type { margin-top: 4px; }
`;
