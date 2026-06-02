// odysseus theme picker (static/js/theme.js theme grid). An anchored popover of
// the 16 built-in presets; each swatch previews its bg/panel + accent. Picking
// one applies it (buildThemeVars) and persists. Custom themes + the color-picker
// editor + font/density are a later refinement.

import type { ReactNode } from "react";
import { ODYSSEUS_THEMES, type ThemeName } from "./odysseus-theme";

export function ThemeMenu({
  open,
  current,
  onPick,
  onClose,
}: {
  open: boolean;
  current: ThemeName;
  onPick: (name: ThemeName) => void;
  onClose: () => void;
}): ReactNode {
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
          {Object.entries(ODYSSEUS_THEMES).map(([name, palette]) => (
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
      </div>
    </div>
  );
}
