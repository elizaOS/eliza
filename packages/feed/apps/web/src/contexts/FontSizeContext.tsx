/**
 * Font Size Context Provider
 *
 * Provides global font size management for accessibility.
 * Persists user preferences to localStorage and allows both
 * preset sizes (small/medium/large) and custom numeric values.
 */

"use client";

import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useState } from "react";
import { readStorageJson, writeStorageItem } from "@/utils/browser-storage";

/**
 * Font size preset options or custom numeric value.
 */
type FontSize = "small" | "medium" | "large" | number;

/**
 * Font size context interface.
 * Provides current font size, preset, and update functions.
 */
interface FontSizeContextType {
  /** Current font size multiplier (e.g., 1.0 = 100%, 0.875 = 87.5%) */
  fontSize: number;
  /** Set font size to a specific numeric value */
  setFontSize: (size: number) => void;
  /** Current font size preset or custom value */
  fontSizePreset: FontSize;
  /** Set font size using preset or custom value */
  setFontSizePreset: (preset: FontSize) => void;
}

const FontSizeContext = createContext<FontSizeContextType | undefined>(
  undefined,
);

/**
 * Font size preset values (multipliers).
 * Based on 16px base font size.
 */
const FONT_SIZE_PRESETS = {
  small: 0.875, // 14px base
  medium: 1, // 16px base
  large: 1.125, // 18px base
};

const STORAGE_KEY = "feed-font-size";

/**
 * Font size context provider component.
 * Manages font size state and persists to localStorage.
 *
 * @param children - React children to wrap with font size context
 */
export function FontSizeProvider({ children }: { children: ReactNode }) {
  const [fontSize, setFontSizeState] = useState(1); // Default to medium (100%)
  const [fontSizePreset, setFontSizePresetState] = useState<FontSize>("medium");

  // Load from localStorage on mount
  useEffect(() => {
    const stored = readStorageJson<{
      fontSize?: number;
      preset?: FontSize;
    }>("localStorage", STORAGE_KEY);
    if (stored) {
      setFontSizeState(stored.fontSize ?? 1);
      setFontSizePresetState(stored.preset ?? "medium");
    }
  }, []);

  const setFontSize = (size: number) => {
    setFontSizeState(size);
    // Determine preset or custom
    const preset =
      (Object.entries(FONT_SIZE_PRESETS).find(
        ([, value]) => value === size,
      )?.[0] as FontSize) || size;
    setFontSizePresetState(preset);
    writeStorageItem(
      "localStorage",
      STORAGE_KEY,
      JSON.stringify({ fontSize: size, preset }),
    );
  };

  const setFontSizePreset = (preset: FontSize) => {
    if (typeof preset === "string" && preset in FONT_SIZE_PRESETS) {
      const size = FONT_SIZE_PRESETS[preset];
      setFontSizeState(size);
      setFontSizePresetState(preset);
      writeStorageItem(
        "localStorage",
        STORAGE_KEY,
        JSON.stringify({ fontSize: size, preset }),
      );
    } else if (typeof preset === "number") {
      setFontSize(preset);
    }
  };

  return (
    <FontSizeContext.Provider
      value={{ fontSize, setFontSize, fontSizePreset, setFontSizePreset }}
    >
      {children}
    </FontSizeContext.Provider>
  );
}

/**
 * Hook to access font size context.
 *
 * @returns Font size context with current size and update functions
 * @throws Error if used outside FontSizeProvider
 *
 * @example
 * ```typescript
 * const { fontSize, setFontSizePreset } = useFontSize();
 * setFontSizePreset('large');
 * ```
 */
export function useFontSize() {
  const context = useContext(FontSizeContext);
  if (context === undefined) {
    throw new Error("useFontSize must be used within a FontSizeProvider");
  }
  return context;
}
