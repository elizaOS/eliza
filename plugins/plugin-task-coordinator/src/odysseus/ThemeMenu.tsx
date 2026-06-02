// odysseus theme picker (static/js/theme.js theme grid). An anchored popover of
// the 16 built-in presets; each swatch previews its bg/panel + accent. Picking
// one applies it (buildThemeVars) and persists. Custom themes + the color-picker
// editor + font/density are a later refinement.

import { type ReactNode, useState } from "react";
import {
  ODYSSEUS_THEMES,
  type ThemeDensity,
  type ThemeFont,
  type ThemeName,
  type ThemePalette,
} from "./odysseus-theme";

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
] as const;

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
  if (!open) return null;
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
        <div className="od-theme-row">
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
        <div className="od-theme-custom">
          {CUSTOM_KEYS.map((k) => (
            <label key={k} className="od-theme-color">
              <input
                type="color"
                value={custom[k]}
                onChange={(e) => onCustomChange(k, e.target.value)}
                aria-label={`Custom ${k} colour`}
              />
              {k}
            </label>
          ))}
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
