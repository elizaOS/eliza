// odysseus theme picker (static/js/theme.js theme grid + static/js/colorPicker.js
// + the harmony/import-export rows from initThemeUI). An anchored popover of the
// 16 built-in presets; each swatch previews its bg/panel + accent. Picking one
// applies it (buildThemeVars) and persists. Below the grid: font, density,
// background-pattern pills, the five custom-colour rows (each opening odysseus's
// IN-HOUSE HSV picker — hue strip + sat/val square + hex input + recent colours
// + harmony suggestions, ported 1:1 from colorPicker.js, NO native
// <input type=color>), the collapsible "More Colors" advanced editor (the 13
// ADV_KEYS grouped Chat Bubbles / Sidebar / Input / Code / Controls, each row a
// swatch + per-key reset that tracks the computed default, plus a "Clear
// Advanced Overrides" button), a colour-harmony generator (generateHarmonyColors:
// complementary / analogous / triadic / monochromatic from an accent + light/
// dark mode), and JSON theme import/export.
//
// Base-colour writeback flows through onCustomChange(key, hex); advanced-colour
// writeback flows through onAdvancedChange(key, hex) / onClearAdvanced(), so the
// parent's single custom-palette pipeline (OdysseusShell setCustomColors →
// writePref(customTheme) → setThemeName("custom")) stays the only source of
// truth. Per-key reset compares the live value to the *reference* theme (the
// active preset/custom theme) for base keys and to computeAdvancedDefaults() for
// advanced keys, matching theme.js syncResetButtons. Recent colours are the
// picker's own local pref (storage.ts NS), the only persistence this component
// owns. Pure client-side, visual-only.

import {
  ChevronRight,
  Download,
  Minus,
  Pipette,
  RotateCcw,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useEscapeClose } from "./hooks/useEscapeClose";
import { useWindowControls } from "./hooks/useWindowControls";
import {
  ODYSSEUS_THEMES,
  type ThemeDensity,
  type ThemeFont,
  type ThemeName,
  type ThemePalette,
} from "./odysseus-theme";
import { ResizeHandles } from "./ResizeHandles";
import { readPref, writePref } from "./util/storage";

// theme.js renderThemeGrid label mapping — preset keys render lowercase, with
// two special cases: the internal "dark" theme shows as "original" and "gpt"
// shows as "GPT". Custom themes keep their slug verbatim.
function themeLabel(name: string): string {
  if (name === "dark") return "original";
  if (name === "gpt") return "GPT";
  return name;
}

// theme.js initThemeUI tab strip — Browse themes vs Customize.
type ThemeTab = "themes" | "customize";

const FONTS: ThemeFont[] = ["mono", "sans", "serif"];
const DENSITIES: ThemeDensity[] = ["compact", "comfortable", "spacious"];
// theme.js MAX_CUSTOM_THEMES — must mirror the OdysseusShell saveCustomTheme cap.
const MAX_CUSTOM_THEMES = 8;
type CustomKey = "bg" | "fg" | "panel" | "border" | "red";
const CUSTOM_KEYS: CustomKey[] = ["bg", "fg", "panel", "border", "red"];
const BG_PATTERNS = [
  "none",
  "dots",
  "sparkles",
  "petals",
  "rain",
  "constellations",
  "embers",
  "synapse",
  "perlin",
] as const;

// Recent-colours pref (colorPicker.js LS_RECENT 'odysseus-recent-colors'); owned
// by this view, not part of the shared PREF_KEYS table.
const RECENT_COLORS_KEY = "recent-colors";
const MAX_RECENT = 12;

// Preview swatch order matches theme.js harmony-preview: bg, panel, fg, border, red.
const PREVIEW_KEYS: CustomKey[] = ["bg", "panel", "fg", "border", "red"];

// Advanced "More Colors" editor (theme.js ADV_KEYS), grouped exactly as the
// odysseus index.html #themeAdvanced section. Each key maps to a CSS var the
// expanded buildThemeVars emits (see odysseus-theme.ts). Ported 1:1.
type AdvKey =
  | "userBubbleBg"
  | "aiBubbleBg"
  | "bubbleBorder"
  | "sidebarBg"
  | "brandColor"
  | "hamburgerColor"
  | "inputBg"
  | "inputBorder"
  | "sendBtnBg"
  | "sendBtnHover"
  | "codeBg"
  | "codeFg"
  | "toggleActive";

interface AdvKeyDef {
  key: AdvKey;
  label: string;
  group: string;
}

const ADV_KEYS: AdvKeyDef[] = [
  { key: "userBubbleBg", label: "User Chat Bubble", group: "Chat Bubbles" },
  { key: "aiBubbleBg", label: "AI Chat Bubble", group: "Chat Bubbles" },
  { key: "bubbleBorder", label: "Border Chat Bubble", group: "Chat Bubbles" },
  { key: "sidebarBg", label: "Sidebar Bg", group: "Sidebar" },
  { key: "brandColor", label: "Odysseus Logo", group: "Sidebar" },
  { key: "hamburgerColor", label: "Hamburger Menu", group: "Sidebar" },
  { key: "inputBg", label: "Input Bg", group: "Chat Input / Prompt Area" },
  {
    key: "inputBorder",
    label: "Input Border",
    group: "Chat Input / Prompt Area",
  },
  { key: "sendBtnBg", label: "Send Btn", group: "Chat Input / Prompt Area" },
  {
    key: "sendBtnHover",
    label: "Send Hover",
    group: "Chat Input / Prompt Area",
  },
  { key: "codeBg", label: "Code Bg", group: "Code Blocks" },
  { key: "codeFg", label: "Code Text", group: "Code Blocks" },
  { key: "toggleActive", label: "Toggle On", group: "Controls" },
];

// Stable group order (Map preserves insertion; ADV_KEYS is already grouped).
const ADV_GROUP_ORDER = [
  "Chat Bubbles",
  "Sidebar",
  "Chat Input / Prompt Area",
  "Code Blocks",
  "Controls",
];

type AdvancedPalette = Partial<Record<AdvKey, string>>;

// Customize-tab "Colors" card order + labels (index.html L466-473). The
// odysseus base grid also carries a "Sidebar" row that writes to the advanced
// `sidebarBg` key (there is no base CUSTOM_KEY for it), so it is rendered as an
// advanced-backed row inline with the base colour rows.
interface ColorRowDef {
  kind: "base" | "adv";
  baseKey?: CustomKey;
  advKey?: AdvKey;
  label: string;
}
const COLORS_CARD_ROWS: ColorRowDef[] = [
  { kind: "base", baseKey: "bg", label: "Background" },
  { kind: "base", baseKey: "fg", label: "Text" },
  { kind: "base", baseKey: "panel", label: "Panel" },
  { kind: "adv", advKey: "sidebarBg", label: "Sidebar" },
  { kind: "base", baseKey: "border", label: "Border" },
  { kind: "base", baseKey: "red", label: "Accent" },
];

const HARMONY_TYPES = [
  "complementary",
  "analogous",
  "triadic",
  "monochromatic",
] as const;
type HarmonyType = (typeof HARMONY_TYPES)[number];
type HarmonyMode = "dark" | "light";

function toHarmonyType(value: string): HarmonyType {
  const match = HARMONY_TYPES.find((t) => t === value);
  return match ?? "complementary";
}

function toHarmonyMode(value: string): HarmonyMode {
  return value === "light" ? "light" : "dark";
}

const HEX6 = /^#[0-9a-f]{6}$/i;

// ── Colour maths (colorPicker.js + theme.js, ported 1:1) ──────────────────
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}
interface Hsv {
  h: number;
  s: number;
  v: number;
}

function hexToRgb(hex: string): Rgb {
  let h = hex.replace("#", "");
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (!/^[0-9a-f]{6}$/i.test(h)) return { r: 0, g: 0, b: 0 };
  const n = Number.parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((v) =>
      Math.round(clamp(v, 0, 255))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function rgbToHsv(r0: number, g0: number, b0: number): Hsv {
  const r = r0 / 255;
  const g = g0 / 255;
  const b = b0 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const s = max === 0 ? 0 : d / max;
  const v = max;
  let h: number;
  if (d === 0) h = 0;
  else if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s: s * 100, v: v * 100 };
}

function hsvToRgb(h0: number, s0: number, v0: number): Rgb {
  const h = (((h0 % 360) + 360) % 360) / 60;
  const s = s0 / 100;
  const v = v0 / 100;
  const i = Math.floor(h);
  const f = h - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r: number;
  let g: number;
  let b: number;
  switch (i % 6) {
    case 0:
      r = v;
      g = t;
      b = p;
      break;
    case 1:
      r = q;
      g = v;
      b = p;
      break;
    case 2:
      r = p;
      g = v;
      b = t;
      break;
    case 3:
      r = p;
      g = q;
      b = v;
      break;
    case 4:
      r = t;
      g = p;
      b = v;
      break;
    default:
      r = v;
      g = p;
      b = q;
      break;
  }
  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255),
  };
}

function hsvToHex(h: number, s: number, v: number): string {
  const { r, g, b } = hsvToRgb(h, s, v);
  return rgbToHex(r, g, b);
}

function hexToHsv(hex: string): Hsv {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHsv(r, g, b);
}

// theme.js hexToHSL → [h(0..360), s(0..100), l(0..100)]
function hexToHsl(hex: string): [number, number, number] {
  const { r: r0, g: g0, b: b0 } = hexToRgb(hex);
  const r = r0 / 255;
  const g = g0 / 255;
  const b = b0 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h * 360, s * 100, l * 100];
}

// theme.js hslToHex
function hslToHex(h0: number, s0: number, l0: number): string {
  const h = ((h0 % 360) + 360) % 360;
  const s = clamp(s0, 0, 100) / 100;
  const l = clamp(l0, 0, 100) / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  const toHex = (v: number): string =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

// theme.js generateHarmonyColors → the five base colours (no advanced).
function generateHarmonyColors(
  accentHex: string,
  harmonyType: HarmonyType,
  mode: HarmonyMode,
): ThemePalette {
  const [h, s] = hexToHsl(accentHex);
  const isDark = mode === "dark";

  let bgH: number;
  let bgS: number;
  let bgL: number;
  let fgS: number;
  let fgL: number;
  let panelL: number;
  let borderH: number;
  let borderS: number;
  let borderL: number;

  if (harmonyType === "complementary") {
    bgH = h;
    bgS = Math.max(s * 0.15, 3);
    bgL = isDark ? 13 : 95;
    fgL = isDark ? 85 : 15;
    fgS = Math.max(s * 0.2, 5);
    panelL = isDark ? 8 : 98;
    borderH = h;
    borderS = Math.max(s * 0.25, 8);
    borderL = isDark ? 28 : 75;
  } else if (harmonyType === "analogous") {
    bgH = (h - 30 + 360) % 360;
    bgS = Math.max(s * 0.12, 3);
    bgL = isDark ? 14 : 95;
    fgL = isDark ? 84 : 18;
    fgS = Math.max(s * 0.15, 5);
    panelL = isDark ? 9 : 97;
    borderH = (h + 30) % 360;
    borderS = Math.max(s * 0.3, 10);
    borderL = isDark ? 30 : 72;
  } else if (harmonyType === "triadic") {
    bgH = (h + 240) % 360;
    bgS = Math.max(s * 0.1, 2);
    bgL = isDark ? 13 : 96;
    fgL = isDark ? 86 : 14;
    fgS = Math.max(s * 0.18, 5);
    panelL = isDark ? 8 : 99;
    borderH = (h + 120) % 360;
    borderS = Math.max(s * 0.2, 8);
    borderL = isDark ? 28 : 74;
  } else {
    bgH = h;
    bgS = Math.max(s * 0.08, 2);
    bgL = isDark ? 12 : 96;
    fgL = isDark ? 87 : 13;
    fgS = Math.max(s * 0.15, 5);
    panelL = isDark ? 7 : 99;
    borderH = h;
    borderS = Math.max(s * 0.2, 6);
    borderL = isDark ? 26 : 76;
  }

  return {
    bg: hslToHex(bgH, bgS, bgL),
    fg: hslToHex(h, fgS, fgL),
    panel: hslToHex(bgH, bgS * 0.6, panelL),
    border: hslToHex(borderH, borderS, borderL),
    red: accentHex,
  };
}

// theme.js computeAdvancedDefaults — the value each advanced key falls back to
// when there is no override. Derives codeBg/codeFg the same way applyColors'
// deriveSyntaxColors does (bg luminance ±4), so the advanced editor's swatches
// track the base palette exactly. Ported 1:1.
function computeAdvancedDefaults(c: ThemePalette): Record<AdvKey, string> {
  const [bgH, bgS, bgL] = hexToHsl(c.bg);
  const isDark = bgL < 50;
  const codeBgL = isDark ? Math.max(bgL - 4, 0) : Math.min(bgL + 4, 100);
  const red = HEX6.test(c.red) ? c.red : "#e06c75";
  return {
    userBubbleBg: c.bg,
    aiBubbleBg: c.panel,
    bubbleBorder: c.border,
    sidebarBg: c.panel,
    brandColor: red,
    hamburgerColor: c.fg,
    inputBg: c.panel,
    inputBorder: c.border,
    sendBtnBg: red,
    sendBtnHover: red,
    codeBg: hslToHex(bgH, bgS, codeBgL),
    codeFg: c.fg,
    toggleActive: red,
  };
}

// colorPicker.js computeSuggestions — five harmony swatches off the live HSV.
interface Suggestion {
  hex: string;
  label: string;
}
function computeSuggestions(h: number, s: number, v: number): Suggestion[] {
  return [
    { hex: hsvToHex(h + 180, s, v), label: "Complement" },
    { hex: hsvToHex(h + 30, s, v), label: "Analogous +30°" },
    { hex: hsvToHex(h - 30, s, v), label: "Analogous -30°" },
    { hex: hsvToHex(h + 150, s, v), label: "Split-complement" },
    {
      hex: hsvToHex(h, s, clamp(v > 50 ? v - 30 : v + 30, 10, 95)),
      label: "Tone shift",
    },
  ];
}

function normalizeHex(input: string): string | null {
  let v = input.trim();
  if (!v.startsWith("#")) v = `#${v}`;
  return HEX6.test(v) ? v.toLowerCase() : null;
}

// ── In-house HSV picker popover (colorPicker.js buildPopover/syncUI/handleDrag) ──
function ColorPickerPopover({
  value,
  recents,
  onPreview,
  onCommit,
  onClose,
}: {
  value: string;
  recents: string[];
  onPreview: (hex: string) => void;
  onCommit: (hex: string) => void;
  onClose: () => void;
}): ReactNode {
  const init = hexToHsv(value);
  const [hsv, setHsv] = useState<Hsv>(init);
  const [hexText, setHexText] = useState(value);
  const slRef = useRef<HTMLButtonElement>(null);
  const hueRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<"sl" | "hue" | null>(null);

  const current = hsvToHex(hsv.h, hsv.s, hsv.v);
  const pureHue = hsvToHex(hsv.h, 100, 100);
  const suggestions = computeSuggestions(hsv.h, hsv.s, hsv.v);

  const pushPreview = useCallback(
    (next: Hsv) => {
      setHsv(next);
      const hex = hsvToHex(next.h, next.s, next.v);
      setHexText(hex);
      onPreview(hex);
    },
    [onPreview],
  );

  const handleDrag = useCallback(
    (e: PointerEvent | React.PointerEvent) => {
      const mode = dragRef.current;
      if (mode === "sl" && slRef.current) {
        const r = slRef.current.getBoundingClientRect();
        const x = clamp((e.clientX - r.left) / r.width, 0, 1);
        const y = clamp((e.clientY - r.top) / r.height, 0, 1);
        pushPreview({ h: hsv.h, s: x * 100, v: (1 - y) * 100 });
      } else if (mode === "hue" && hueRef.current) {
        const r = hueRef.current.getBoundingClientRect();
        const x = clamp((e.clientX - r.left) / r.width, 0, 1);
        pushPreview({ h: x * 360, s: hsv.s, v: hsv.v });
      }
    },
    [hsv.h, hsv.s, hsv.v, pushPreview],
  );

  // Window-level pointer listeners while dragging (colorPicker.js
  // _installWindowPointer): a drag started on the square/hue keeps tracking
  // even when the pointer leaves the element, and commits on release.
  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      if (dragRef.current) handleDrag(e);
    };
    const onUp = (): void => {
      if (dragRef.current) {
        dragRef.current = null;
        onCommit(hsvToHex(hsv.h, hsv.s, hsv.v));
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [handleDrag, hsv.h, hsv.s, hsv.v, onCommit]);

  const startDrag = (mode: "sl" | "hue") => (e: React.PointerEvent) => {
    dragRef.current = mode;
    handleDrag(e);
    e.preventDefault();
  };

  const applyHex = (raw: string): void => {
    setHexText(raw);
    const hex = normalizeHex(raw);
    if (hex) {
      const v = hexToHsv(hex);
      setHsv(v);
      onPreview(hex);
    }
  };

  const pickSwatch = (hex: string): void => {
    const v = hexToHsv(hex);
    setHsv(v);
    setHexText(hex);
    onPreview(hex);
    onCommit(hex);
  };

  const eyedrop = useCallback((): void => {
    const Picker = (
      window as unknown as {
        EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> };
      }
    ).EyeDropper;
    if (!Picker) return;
    void new Picker()
      .open()
      .then((r) => {
        const hex = normalizeHex(r.sRGBHex);
        if (!hex) return;
        setHsv(hexToHsv(hex));
        setHexText(hex);
        onPreview(hex);
        onCommit(hex);
      })
      .catch(() => {
        // user cancelled the OS eyedropper — no-op
      });
  }, [onPreview, onCommit]);

  const eyedropperSupported =
    typeof window !== "undefined" && "EyeDropper" in window;

  return (
    <fieldset className="od-cp-popover" aria-label="Colour picker">
      <button
        type="button"
        ref={slRef}
        className="od-cp-sl"
        style={{ background: pureHue }}
        onPointerDown={startDrag("sl")}
        aria-label="Saturation and value"
      >
        <span className="od-cp-sl-white" />
        <span className="od-cp-sl-black" />
        <span
          className="od-cp-sl-handle"
          style={{ left: `${hsv.s}%`, top: `${100 - hsv.v}%` }}
        />
      </button>
      <button
        type="button"
        ref={hueRef}
        className="od-cp-hue"
        onPointerDown={startDrag("hue")}
        aria-label="Hue"
      >
        <span
          className="od-cp-hue-handle"
          style={{ left: `${(hsv.h / 360) * 100}%` }}
        />
      </button>
      <div className="od-cp-row">
        <span className="od-cp-preview" style={{ background: current }} />
        <input
          className="od-cp-hex"
          type="text"
          maxLength={7}
          spellCheck={false}
          autoComplete="off"
          value={hexText}
          onChange={(e) => applyHex(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const hex = normalizeHex(hexText);
              if (hex) onCommit(hex);
              onClose();
            }
            if (e.key === "Escape") onClose();
          }}
          aria-label="Hex colour"
        />
        <button
          type="button"
          className="od-cp-eyedropper"
          title={
            eyedropperSupported
              ? "Eyedropper"
              : "Eyedropper not supported in this browser"
          }
          aria-label="Eyedropper"
          disabled={!eyedropperSupported}
          onClick={eyedrop}
        >
          <Pipette size={13} />
        </button>
      </div>
      <div className="od-cp-section-label">Suggestions</div>
      <div className="od-cp-swatches">
        {suggestions.map((sug) => (
          <button
            type="button"
            key={sug.label}
            className="od-cp-swatch"
            title={`${sug.label}: ${sug.hex}`}
            style={{ background: sug.hex }}
            onClick={() => pickSwatch(sug.hex)}
            aria-label={sug.label}
          />
        ))}
      </div>
      <div className="od-cp-section-label">Recent</div>
      <div className="od-cp-swatches">
        {recents.length > 0 ? (
          recents.map((hex) => (
            <button
              type="button"
              key={hex}
              className="od-cp-swatch"
              title={hex}
              style={{ background: hex }}
              onClick={() => pickSwatch(hex)}
              aria-label={`Recent ${hex}`}
            />
          ))
        ) : (
          <span className="od-cp-recent-empty">(none yet)</span>
        )}
      </div>
    </fieldset>
  );
}

export function ThemeMenu({
  open,
  current,
  onPick,
  onClose,
  font,
  density,
  onSetFont,
  onSetDensity,
  custom,
  onCustomChange,
  customAdvanced,
  onAdvancedChange,
  onClearAdvanced,
  bgPattern,
  onSetBg,
  customThemes,
  onSaveCustom,
  onDeleteCustom,
}: {
  open: boolean;
  current: ThemeName;
  onPick: (name: ThemeName) => void;
  onClose: () => void;
  font: ThemeFont;
  density: ThemeDensity;
  onSetFont: (font: ThemeFont) => void;
  onSetDensity: (density: ThemeDensity) => void;
  custom: ThemePalette;
  onCustomChange: (key: CustomKey, value: string) => void;
  /** Current advanced overrides; absent keys fall back to computed defaults. */
  customAdvanced?: AdvancedPalette;
  /** Set one advanced override (theme.js adv-<key> input handler). */
  onAdvancedChange?: (key: AdvKey, value: string) => void;
  /** Strip all advanced overrides (theme.js #theme-adv-clear). */
  onClearAdvanced?: () => void;
  bgPattern: string;
  onSetBg: (pattern: string) => void;
  customThemes: Record<string, ThemePalette>;
  onSaveCustom: (name: string) => void;
  onDeleteCustom: (name: string) => void;
}): ReactNode {
  const [activeTab, setActiveTab] = useState<ThemeTab>("themes");
  // theme.js theme-opacity-toggle ("Peek") — fades the modal so the page
  // behind it shows through; only meaningful on the Customize tab.
  const [peek, setPeek] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveError, setSaveError] = useState("");
  const [pickerKey, setPickerKey] = useState<CustomKey | null>(null);
  const [advPickerKey, setAdvPickerKey] = useState<AdvKey | null>(null);
  const [advOpen, setAdvOpen] = useState(false);
  const [recents, setRecents] = useState<string[]>([]);
  const [harmonyAccent, setHarmonyAccent] = useState(custom.red);
  const [harmonyType, setHarmonyType] = useState<HarmonyType>("complementary");
  const [harmonyMode, setHarmonyMode] = useState<HarmonyMode>("dark");
  const [accentPickerOpen, setAccentPickerOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState("");
  const [exported, setExported] = useState(false);

  // Centered, draggable + edge-resizable modal window (windowDrag.js /
  // windowResize.js port), matching the other odysseus tool modals. The theme
  // popup is the small compact dialog from index.html #theme-popup.
  useEscapeClose(open, onClose);
  const win = useWindowControls("win-theme", { w: 520, h: 600 });

  useEffect(() => {
    if (open) setRecents(readPref<string[]>(RECENT_COLORS_KEY, []));
  }, [open]);

  // Keep the harmony accent in sync if the base "red" colour changes underneath
  // us (e.g. the user edits the Accent custom colour while the menu stays
  // mounted) — otherwise the harmony swatch + Generate preview go stale.
  useEffect(() => {
    setHarmonyAccent(custom.red);
  }, [custom.red]);

  // colorPicker.js addRecent — newest first, deduped, capped at MAX_RECENT.
  const commitRecent = useCallback((hex: string) => {
    const norm = normalizeHex(hex);
    if (!norm) return;
    setRecents((prev) => {
      const next = [norm, ...prev.filter((c) => c !== norm)].slice(
        0,
        MAX_RECENT,
      );
      writePref(RECENT_COLORS_KEY, next);
      return next;
    });
  }, []);

  if (!open) return null;
  if (win.minimized) return null;

  const applyPalette = (palette: ThemePalette): void => {
    for (const key of CUSTOM_KEYS) {
      onCustomChange(key, palette[key]);
    }
  };

  const harmonyPreview = generateHarmonyColors(
    HEX6.test(harmonyAccent) ? harmonyAccent : "#e06c75",
    harmonyType,
    harmonyMode,
  );

  // ── Advanced editor support ──────────────────────────────────────────────
  const adv: AdvancedPalette = customAdvanced ?? {};
  const advDefaults = computeAdvancedDefaults(custom);
  // The effective swatch value: an override if set, else the computed default.
  const advValue = (key: AdvKey): string => adv[key] ?? advDefaults[key];

  // Reference palette for per-key reset — the active preset/custom theme you
  // started from (theme.js refColors). Base resets snap to it; advanced resets
  // snap to that reference's computed defaults.
  const refColors: ThemePalette =
    ODYSSEUS_THEMES[current] ?? customThemes[current] ?? custom;
  const refAdvDefaults = computeAdvancedDefaults(refColors);

  // theme.js syncResetButtons — a base key is "changed" when it differs from
  // the reference theme's value; an advanced key when it differs from the
  // reference theme's computed default.
  const baseChanged = (key: CustomKey): boolean => {
    const ref = refColors[key];
    return (
      HEX6.test(ref) &&
      HEX6.test(custom[key]) &&
      custom[key].toLowerCase() !== ref.toLowerCase()
    );
  };
  const advChanged = (key: AdvKey): boolean => {
    const ref = refAdvDefaults[key];
    const cur = advValue(key);
    return cur.toLowerCase() !== ref.toLowerCase();
  };

  const resetBase = (key: CustomKey): void => {
    const ref = refColors[key];
    if (HEX6.test(ref)) onCustomChange(key, ref);
  };
  const resetAdv = (key: AdvKey): void => {
    onAdvancedChange?.(key, refAdvDefaults[key]);
  };

  // A single Customize > Colors card row. Base keys (bg/fg/panel/border/red)
  // write through onCustomChange; the lone advanced-backed row ("Sidebar")
  // writes through onAdvancedChange so it tracks the same single-pipeline as
  // the rest of the advanced editor (theme.js wires #adv-sidebarBg the same way).
  const renderColorRow = (row: ColorRowDef): ReactNode => {
    if (row.kind === "adv" && row.advKey) {
      const aKey = row.advKey;
      const hex = advValue(aKey);
      const open = advPickerKey === aKey;
      return (
        <div key={`adv-${aKey}`} className="od-theme-color-row">
          <button
            type="button"
            className="od-cp-swatch-trigger"
            style={{ background: hex }}
            onClick={() =>
              setAdvPickerKey((cur) => (cur === aKey ? null : aKey))
            }
            aria-label={`Edit ${row.label}`}
            aria-expanded={open}
          />
          <span className="od-theme-color-key">{row.label}</span>
          <span className="od-theme-color-hex">{hex}</span>
          <button
            type="button"
            className={`od-theme-reset-btn${advChanged(aKey) ? " changed" : ""}`}
            onClick={() => resetAdv(aKey)}
            disabled={!advChanged(aKey)}
            title={`Reset ${row.label}`}
            aria-label={`Reset ${row.label}`}
          >
            <RotateCcw size={11} />
          </button>
          {open ? (
            <ColorPickerPopover
              value={HEX6.test(hex) ? hex : "#000000"}
              recents={recents}
              onPreview={(next) => onAdvancedChange?.(aKey, next)}
              onCommit={(next) => {
                onAdvancedChange?.(aKey, next);
                commitRecent(next);
              }}
              onClose={() => setAdvPickerKey(null)}
            />
          ) : null}
        </div>
      );
    }
    if (!row.baseKey) return null;
    const bKey = row.baseKey;
    const open = pickerKey === bKey;
    return (
      <div key={`base-${bKey}`} className="od-theme-color-row">
        <button
          type="button"
          className="od-cp-swatch-trigger"
          style={{ background: custom[bKey] }}
          onClick={() => setPickerKey((cur) => (cur === bKey ? null : bKey))}
          aria-label={`Edit ${row.label}`}
          aria-expanded={open}
        />
        <span className="od-theme-color-key">{row.label}</span>
        <span className="od-theme-color-hex">{custom[bKey]}</span>
        <button
          type="button"
          className={`od-theme-reset-btn${baseChanged(bKey) ? " changed" : ""}`}
          onClick={() => resetBase(bKey)}
          disabled={!baseChanged(bKey)}
          title={`Reset ${row.label} to ${current}`}
          aria-label={`Reset ${row.label}`}
        >
          <RotateCcw size={11} />
        </button>
        {open ? (
          <ColorPickerPopover
            value={HEX6.test(custom[bKey]) ? custom[bKey] : "#000000"}
            recents={recents}
            onPreview={(hex) => onCustomChange(bKey, hex)}
            onCommit={(hex) => {
              onCustomChange(bKey, hex);
              commitRecent(hex);
            }}
            onClose={() => setPickerKey(null)}
          />
        ) : null}
      </div>
    );
  };

  // theme.js doSave — name/slug/builtin/limit validation, surfaced inline.
  const handleSave = (): void => {
    setSaveError("");
    const name = saveName.trim();
    if (!name) {
      setSaveError("Enter a name.");
      return;
    }
    const slug = name
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "");
    if (!slug) {
      setSaveError("Invalid name.");
      return;
    }
    if (ODYSSEUS_THEMES[slug]) {
      setSaveError("Cannot overwrite a built-in theme.");
      return;
    }
    const isNew = !(slug in customThemes);
    if (isNew && Object.keys(customThemes).length >= MAX_CUSTOM_THEMES) {
      setSaveError(`Max ${MAX_CUSTOM_THEMES} custom themes. Delete one first.`);
      return;
    }
    onSaveCustom(slug);
    setSaveName("");
  };

  const handleExport = (): void => {
    const name = current || "custom";
    const obj = { name, colors: custom, font, density, bgPattern };
    const json = JSON.stringify(obj, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `odysseus_${name}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setExported(true);
    window.setTimeout(() => setExported(false), 1500);
  };

  const handleImport = (): void => {
    setImportError("");
    let parsed: unknown;
    try {
      parsed = JSON.parse(importText.trim());
    } catch {
      setImportError("Invalid JSON.");
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
      setImportError("Invalid theme object.");
      return;
    }
    const root = parsed as Record<string, unknown>;
    const colorsSource =
      typeof root.colors === "object" && root.colors !== null
        ? (root.colors as Record<string, unknown>)
        : root;
    const missing = CUSTOM_KEYS.filter(
      (k) => typeof colorsSource[k] !== "string",
    );
    if (missing.length > 0) {
      setImportError(`Missing: ${missing.join(", ")}`);
      return;
    }
    const palette: ThemePalette = {
      bg: "",
      fg: "",
      panel: "",
      border: "",
      red: "",
    };
    for (const k of CUSTOM_KEYS) {
      const raw = colorsSource[k];
      if (typeof raw !== "string" || !HEX6.test(raw)) {
        setImportError(`Bad hex for ${k}`);
        return;
      }
      palette[k] = raw;
    }
    applyPalette(palette);
    const rawName = typeof root.name === "string" ? root.name : "imported";
    const slug =
      rawName
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "") || "imported";
    if (typeof root.bgPattern === "string") onSetBg(root.bgPattern);
    onSaveCustom(slug);
    setImportOpen(false);
    setImportText("");
  };

  const customEntries = Object.entries(customThemes);

  // A theme swatch — the coin-stack of four overlapping colour circles
  // (bg, panel, fg, red) above a centred name (theme.js renderThemeGrid +
  // style.css .theme-swatch). Used for both preset and custom grids.
  const renderSwatch = (
    name: string,
    palette: ThemePalette,
    isCustom: boolean,
  ): ReactNode => (
    <button
      type="button"
      key={name}
      className={`od-theme-swatch${name === current ? " active" : ""}`}
      onClick={() => {
        onPick(name);
        onClose();
      }}
    >
      <span className="od-theme-swatch-colors">
        <span style={{ background: palette.bg }} />
        <span style={{ background: palette.panel }} />
        <span style={{ background: palette.fg }} />
        <span style={{ background: palette.red }} />
      </span>
      <span className="od-theme-swatch-name">
        {isCustom ? name : themeLabel(name)}
      </span>
      {isCustom ? (
        <button
          type="button"
          className="od-theme-delete-btn"
          onClick={(e) => {
            e.stopPropagation();
            onDeleteCustom(name);
          }}
          aria-label={`Delete ${name}`}
          title="Delete theme"
        >
          <X size={11} />
        </button>
      ) : null}
    </button>
  );

  return (
    <div
      className={`od-search-overlay od-theme-overlay${win.windowed ? " od-windowed" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Theme"
    >
      <button
        type="button"
        className="od-search-backdrop"
        aria-label="Close theme menu"
        onClick={onClose}
      />
      {win.snapGhost ? (
        <div
          className="od-snap-ghost"
          style={win.snapGhost}
          aria-hidden="true"
        />
      ) : null}
      <div
        className={`od-search-panel od-theme-panel${peek ? " od-theme-peek" : ""}`}
        style={win.panelStyle}
      >
        <ResizeHandles controls={win} />
        {/* ── Header (index.html .theme-popup-header) ── */}
        <div
          className="od-theme-header od-window-header"
          onPointerDown={win.onDragStart}
        >
          <span className="od-theme-title">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              role="img"
              aria-label="Theme"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M12 2a7 7 0 0 0 0 20 4 4 0 0 1 0-8 4 4 0 0 0 0-8" />
              <circle cx="8" cy="9" r="1.5" fill="currentColor" />
              <circle cx="15" cy="14" r="1.5" fill="currentColor" />
              <circle cx="9" cy="15" r="1.5" fill="currentColor" />
            </svg>
            Theme
          </span>
          {activeTab === "customize" ? (
            <button
              type="button"
              className={`od-theme-peek-btn${peek ? " active" : ""}`}
              onClick={() => setPeek((v) => !v)}
              aria-pressed={peek}
              title="Fade this window to preview the page behind it"
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <span className="od-theme-peek-label">Peek</span>
            </button>
          ) : null}
          <button
            type="button"
            className="od-window-min-btn"
            onClick={win.minimize}
            title="Minimize"
            aria-label="Minimize"
          >
            <Minus size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="od-theme-close"
            onClick={onClose}
            aria-label="Close theme"
            title="Close"
          >
            <X size={14} />
          </button>
        </div>

        {/* ── Tab strip (index.html #theme-tabs) ── */}
        <div className="od-theme-tabs">
          <button
            type="button"
            className={`od-theme-tab${activeTab === "themes" ? " active" : ""}`}
            onClick={() => setActiveTab("themes")}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M12 2a7 7 0 0 0 0 20 4 4 0 0 1 0-8 4 4 0 0 0 0-8" />
              <circle cx="8" cy="9" r="1.4" fill="currentColor" />
              <circle cx="15" cy="14" r="1.4" fill="currentColor" />
              <circle cx="9" cy="15" r="1.4" fill="currentColor" />
            </svg>
            Themes
          </button>
          <button
            type="button"
            className={`od-theme-tab${activeTab === "customize" ? " active" : ""}`}
            onClick={() => setActiveTab("customize")}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M9.06 11.9l-3.5 3.5a2.85 2.85 0 1 0 4.03 4.03l8.49-8.49a4.5 4.5 0 1 0-6.36-6.36L3.18 12.62" />
              <path d="M14 7l3 3" />
            </svg>
            Customize
          </button>
        </div>

        {/* ── Tab: Browse themes (index.html #theme-tab-browse) ── */}
        {activeTab === "themes" ? (
          <div className="od-theme-tab-panel">
            <div className="od-theme-card">
              <h2>Default Themes</h2>
              <div className="od-theme-grid">
                {Object.entries(ODYSSEUS_THEMES).map(([name, palette]) =>
                  renderSwatch(name, palette, false),
                )}
              </div>
            </div>
            {customEntries.length > 0 ? (
              <div className="od-theme-card">
                <h2>Your Themes</h2>
                <div className="od-theme-grid">
                  {customEntries.map(([name, palette]) =>
                    renderSwatch(name, palette, true),
                  )}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* ── Tab: Customize (index.html #theme-tab-customize) ── */}
        {activeTab === "customize" ? (
          <div className="od-theme-tab-panel">
            <div className="od-theme-card">
              <h2>Colors</h2>
              <div className="od-theme-custom-grid">
                {COLORS_CARD_ROWS.map((row) => renderColorRow(row))}
              </div>
            </div>
            {onAdvancedChange ? (
              <>
                <button
                  type="button"
                  className={`od-theme-adv-toggle${advOpen ? " open" : ""}`}
                  onClick={() => setAdvOpen((v) => !v)}
                  aria-expanded={advOpen}
                >
                  <ChevronRight size={13} className="od-theme-adv-arrow" />
                  More Colors
                </button>
                {advOpen ? (
                  <div className="od-theme-adv-section">
                    {ADV_GROUP_ORDER.map((group) => (
                      <div key={group} className="od-theme-adv-group">
                        <div className="od-theme-adv-group-label">{group}</div>
                        <div className="od-theme-custom-rows">
                          {ADV_KEYS.filter((d) => d.group === group).map(
                            (def) => (
                              <div key={def.key} className="od-theme-color-row">
                                <button
                                  type="button"
                                  className="od-cp-swatch-trigger"
                                  style={{ background: advValue(def.key) }}
                                  onClick={() =>
                                    setAdvPickerKey((cur) =>
                                      cur === def.key ? null : def.key,
                                    )
                                  }
                                  aria-label={`Edit ${def.label}`}
                                  aria-expanded={advPickerKey === def.key}
                                />
                                <span className="od-theme-color-key">
                                  {def.label}
                                </span>
                                <span className="od-theme-color-hex">
                                  {advValue(def.key)}
                                </span>
                                <button
                                  type="button"
                                  className={`od-theme-reset-btn${advChanged(def.key) ? " changed" : ""}`}
                                  onClick={() => resetAdv(def.key)}
                                  disabled={!advChanged(def.key)}
                                  title={`Reset ${def.label}`}
                                  aria-label={`Reset ${def.label}`}
                                >
                                  <RotateCcw size={11} />
                                </button>
                                {advPickerKey === def.key ? (
                                  <ColorPickerPopover
                                    value={
                                      HEX6.test(advValue(def.key))
                                        ? advValue(def.key)
                                        : "#000000"
                                    }
                                    recents={recents}
                                    onPreview={(hex) =>
                                      onAdvancedChange(def.key, hex)
                                    }
                                    onCommit={(hex) => {
                                      onAdvancedChange(def.key, hex);
                                      commitRecent(hex);
                                    }}
                                    onClose={() => setAdvPickerKey(null)}
                                  />
                                ) : null}
                              </div>
                            ),
                          )}
                        </div>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="od-theme-adv-clear"
                      onClick={() => onClearAdvanced?.()}
                      disabled={Object.keys(adv).length === 0}
                    >
                      Clear Advanced Overrides
                    </button>
                  </div>
                ) : null}
              </>
            ) : null}
            <div className="od-theme-card">
              <h2>Color Harmony</h2>
              <div className="od-theme-harmony">
                <div className="od-theme-harmony-row">
                  <button
                    type="button"
                    className="od-cp-swatch-trigger"
                    style={{
                      background: HEX6.test(harmonyAccent)
                        ? harmonyAccent
                        : "#e06c75",
                    }}
                    onClick={() => setAccentPickerOpen((v) => !v)}
                    aria-label="Harmony accent colour"
                    aria-expanded={accentPickerOpen}
                  />
                  <select
                    className="od-theme-select"
                    value={harmonyType}
                    onChange={(e) =>
                      setHarmonyType(toHarmonyType(e.target.value))
                    }
                    aria-label="Harmony type"
                  >
                    {HARMONY_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <select
                    className="od-theme-select"
                    value={harmonyMode}
                    onChange={(e) =>
                      setHarmonyMode(toHarmonyMode(e.target.value))
                    }
                    aria-label="Harmony mode"
                  >
                    <option value="dark">dark</option>
                    <option value="light">light</option>
                  </select>
                </div>
                {accentPickerOpen ? (
                  <ColorPickerPopover
                    value={HEX6.test(harmonyAccent) ? harmonyAccent : "#e06c75"}
                    recents={recents}
                    onPreview={setHarmonyAccent}
                    onCommit={(hex) => {
                      setHarmonyAccent(hex);
                      commitRecent(hex);
                    }}
                    onClose={() => setAccentPickerOpen(false)}
                  />
                ) : null}
                <div className="od-theme-harmony-preview">
                  {PREVIEW_KEYS.map((k) => (
                    <span key={k} style={{ background: harmonyPreview[k] }} />
                  ))}
                </div>
                <button
                  type="button"
                  className="od-theme-harmony-gen"
                  onClick={() => applyPalette(harmonyPreview)}
                >
                  <Wand2 size={13} /> Generate
                </button>
              </div>
            </div>
            <div className="od-theme-card">
              <h2>Font &amp; Layout</h2>
              <div className="od-theme-section">Font</div>
              <div className="od-theme-row">
                {FONTS.map((f) => (
                  <button
                    type="button"
                    key={f}
                    className={`od-theme-pill${font === f ? " active" : ""}`}
                    onClick={() => onSetFont(f)}
                  >
                    {f}
                  </button>
                ))}
              </div>
              <div className="od-theme-section">Density</div>
              <div className="od-theme-row">
                {DENSITIES.map((d) => (
                  <button
                    type="button"
                    key={d}
                    className={`od-theme-pill${density === d ? " active" : ""}`}
                    onClick={() => onSetDensity(d)}
                  >
                    {d}
                  </button>
                ))}
              </div>
              <div className="od-theme-section">Background / Effect</div>
              <div className="od-theme-row od-theme-row-wrap">
                {BG_PATTERNS.map((b) => (
                  <button
                    type="button"
                    key={b}
                    className={`od-theme-pill${bgPattern === b ? " active" : ""}`}
                    onClick={() => onSetBg(b)}
                  >
                    {b}
                  </button>
                ))}
              </div>
            </div>
            <div className="od-theme-card">
              <h2>Save / Share</h2>
              <div className="od-theme-save">
                <input
                  className="od-theme-save-input"
                  value={saveName}
                  onChange={(e) => {
                    setSaveName(e.target.value);
                    if (saveError) setSaveError("");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSave();
                  }}
                  placeholder="Theme name…"
                  maxLength={32}
                  aria-label="Custom theme name"
                />
                <button
                  type="button"
                  className="od-theme-pill"
                  onClick={handleSave}
                >
                  Save
                </button>
              </div>
              {saveError ? (
                <div className="od-theme-save-error">{saveError}</div>
              ) : null}
              <div className="od-theme-io">
                <button
                  type="button"
                  className="od-theme-io-btn"
                  onClick={() => {
                    setImportOpen((v) => !v);
                    setImportText("");
                    setImportError("");
                  }}
                >
                  <Upload size={13} /> Import
                </button>
                <button
                  type="button"
                  className="od-theme-io-btn"
                  onClick={handleExport}
                >
                  <Download size={13} /> {exported ? "Downloaded!" : "Export"}
                </button>
              </div>
              {importOpen ? (
                <div className="od-theme-import">
                  <textarea
                    className="od-theme-import-area"
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                    placeholder='{"name":"…","colors":{"bg":"#…","fg":"#…","panel":"#…","border":"#…","red":"#…"}}'
                    aria-label="Theme JSON"
                  />
                  {importError ? (
                    <div className="od-theme-import-error">{importError}</div>
                  ) : null}
                  <div className="od-theme-import-actions">
                    <button
                      type="button"
                      className="od-theme-pill"
                      onClick={handleImport}
                    >
                      Apply
                    </button>
                    <button
                      type="button"
                      className="od-theme-pill"
                      onClick={() => {
                        setImportOpen(false);
                        setImportText("");
                        setImportError("");
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
