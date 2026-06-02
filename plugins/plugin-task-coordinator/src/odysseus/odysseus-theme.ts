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
.odysseus-root { display:flex; height:100%; min-height:0; width:100%; overflow:hidden; position:relative;
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
  overflow:hidden; min-height:0; background:var(--sidebar-bg, var(--panel));
  border-right:1px solid var(--border); box-shadow:0 4px 12px rgba(0,0,0,.1); backdrop-filter:blur(10px); }
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
.odysseus-root .od-thread-menu button { display:block; width:100%; text-align:left; padding:6px 10px; border:none;
  background:none; color:var(--fg); font-size:12px; border-radius:4px; cursor:pointer; }
.odysseus-root .od-thread-menu button:hover { background:color-mix(in srgb, var(--fg) 8%, transparent); }
.odysseus-root .od-thread-menu button.od-danger { color:var(--red); }
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
`;
