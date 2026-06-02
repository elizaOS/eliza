// odysseus theme picker (static/js/theme.js theme grid + static/js/colorPicker.js
// + the harmony/import-export rows from initThemeUI). An anchored popover of the
// 16 built-in presets; each swatch previews its bg/panel + accent. Picking one
// applies it (buildThemeVars) and persists. Below the grid: font, density,
// background-pattern pills, the five custom-colour rows (each opening odysseus's
// IN-HOUSE HSV picker — hue strip + sat/val square + hex input + recent colours
// + harmony suggestions, ported 1:1 from colorPicker.js, NO native
// <input type=color>), a colour-harmony generator (generateHarmonyColors:
// complementary / analogous / triadic / monochromatic from an accent + light/
// dark mode), and JSON theme import/export.
//
// All writeback flows through the existing props — the in-house picker, harmony
// generator and import each call onCustomChange(key, hex) per colour, so the
// parent's single custom-palette pipeline (OdysseusShell setCustomColors →
// writePref(customTheme) → setThemeName("custom")) stays the only source of
// truth. Recent colours are the picker's own local pref (storage.ts NS), the
// only persistence this component owns. Pure client-side, visual-only.

import { Download, Pipette, Upload, Wand2 } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ODYSSEUS_THEMES,
  type ThemeDensity,
  type ThemeFont,
  type ThemeName,
  type ThemePalette,
} from "./odysseus-theme";
import { readPref, writePref } from "./util/storage";

const FONTS: ThemeFont[] = ["mono", "sans", "serif"];
const DENSITIES: ThemeDensity[] = ["compact", "comfortable", "spacious"];
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
  bgPattern: string;
  onSetBg: (pattern: string) => void;
  customThemes: Record<string, ThemePalette>;
  onSaveCustom: (name: string) => void;
  onDeleteCustom: (name: string) => void;
}): ReactNode {
  const [saveName, setSaveName] = useState("");
  const [pickerKey, setPickerKey] = useState<CustomKey | null>(null);
  const [recents, setRecents] = useState<string[]>([]);
  const [harmonyAccent, setHarmonyAccent] = useState(custom.red);
  const [harmonyType, setHarmonyType] = useState<HarmonyType>("complementary");
  const [harmonyMode, setHarmonyMode] = useState<HarmonyMode>("dark");
  const [accentPickerOpen, setAccentPickerOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState("");
  const [exported, setExported] = useState(false);

  useEffect(() => {
    if (open) setRecents(readPref<string[]>(RECENT_COLORS_KEY, []));
  }, [open]);

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

  return (
    <div role="dialog" aria-modal="true" aria-label="Theme">
      <button
        type="button"
        aria-label="Close theme menu"
        onClick={onClose}
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 55,
          background: "transparent",
          border: "none",
          cursor: "default",
        }}
      />
      <div className="od-theme-menu">
        <div className="od-theme-grid">
          {[
            ...Object.entries(ODYSSEUS_THEMES),
            ...Object.entries(customThemes),
          ].map(([name, palette]) => (
            <button
              type="button"
              key={name}
              className={`od-theme-swatch${name === current ? " active" : ""}`}
              onClick={() => {
                onPick(name);
                onClose();
              }}
            >
              <span
                className="od-theme-chip"
                style={{
                  background: `linear-gradient(135deg, ${palette.bg} 0 55%, ${palette.panel} 55% 100%)`,
                  borderColor: palette.red,
                }}
              />
              <span className="od-theme-name">{name}</span>
            </button>
          ))}
        </div>
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
        <div className="od-theme-section">Background</div>
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
        <div className="od-theme-section">Custom</div>
        <div className="od-theme-custom-rows">
          {CUSTOM_KEYS.map((k) => (
            <div key={k} className="od-theme-color-row">
              <button
                type="button"
                className="od-cp-swatch-trigger"
                style={{ background: custom[k] }}
                onClick={() => setPickerKey((cur) => (cur === k ? null : k))}
                aria-label={`Edit ${k} colour`}
                aria-expanded={pickerKey === k}
              />
              <span className="od-theme-color-key">{k}</span>
              <span className="od-theme-color-hex">{custom[k]}</span>
              {pickerKey === k ? (
                <ColorPickerPopover
                  value={HEX6.test(custom[k]) ? custom[k] : "#000000"}
                  recents={recents}
                  onPreview={(hex) => onCustomChange(k, hex)}
                  onCommit={(hex) => {
                    onCustomChange(k, hex);
                    commitRecent(hex);
                  }}
                  onClose={() => setPickerKey(null)}
                />
              ) : null}
            </div>
          ))}
        </div>
        <div className="od-theme-section">Harmony</div>
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
              onChange={(e) => setHarmonyType(toHarmonyType(e.target.value))}
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
              onChange={(e) => setHarmonyMode(toHarmonyMode(e.target.value))}
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
        <div className="od-theme-save">
          <input
            className="od-theme-save-input"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder="name…"
            aria-label="Custom theme name"
          />
          <button
            type="button"
            className="od-theme-pill"
            onClick={() => {
              const n = saveName.trim();
              if (n) {
                onSaveCustom(n);
                setSaveName("");
              }
            }}
          >
            Save
          </button>
        </div>
        <div className="od-theme-io">
          <button
            type="button"
            className="od-theme-io-btn"
            onClick={handleExport}
          >
            <Download size={13} /> {exported ? "Downloaded!" : "Export"}
          </button>
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
        {Object.keys(customThemes).length > 0 ? (
          <div className="od-theme-saved">
            {Object.keys(customThemes).map((name) => (
              <span key={name} className="od-theme-saved-item">
                <button
                  type="button"
                  className="od-theme-saved-name"
                  onClick={() => {
                    onPick(name);
                    onClose();
                  }}
                >
                  {name}
                </button>
                <button
                  type="button"
                  className="od-theme-saved-del"
                  onClick={() => onDeleteCustom(name)}
                  aria-label={`Delete ${name}`}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
