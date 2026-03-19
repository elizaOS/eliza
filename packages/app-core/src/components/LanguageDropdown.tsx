/**
 * LanguageDropdown — language selector used in the app header and settings.
 *
 * Fully props-driven; no app context dependency. Takes the current language
 * and a setter from the caller. Works in both "native" and "companion"
 * visual variants.
 */

import { Check, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { UiLanguage } from "../i18n/messages";

/** Minimal translator function type. Receive key, return string. */
export type TranslatorFn = (key: string) => string;

/** Language metadata with flag emoji and native label. */
export const LANGUAGES: { id: UiLanguage; flag: string; label: string }[] = [
  { id: "en", flag: "🇺🇸", label: "English" },
  { id: "zh-CN", flag: "🇨🇳", label: "中文" },
  { id: "ko", flag: "🇰🇷", label: "한국어" },
  { id: "es", flag: "🇪🇸", label: "Español" },
  { id: "pt", flag: "🇧🇷", label: "Português" },
];

export interface LanguageDropdownProps {
  uiLanguage: UiLanguage;
  setUiLanguage: (language: UiLanguage) => void;
  /** Optional translator for ARIA labels */
  t?: TranslatorFn;
  /** Optional extra className on the root */
  className?: string;
  /** Optional extra className on the trigger button */
  triggerClassName?: string;
  variant?: "native" | "companion";
  menuPlacement?: "bottom-end" | "top-end";
}

export function LanguageDropdown({
  uiLanguage,
  setUiLanguage,
  t,
  className,
  triggerClassName,
  variant = "native",
  menuPlacement = "bottom-end",
}: LanguageDropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{
    top?: number;
    bottom?: number;
    right: number;
  } | null>(null);

  // Compute dropdown position from trigger button rect (for companion portal)
  const updateMenuPos = useCallback(() => {
    if (variant !== "companion" || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    if (menuPlacement === "top-end") {
      setMenuPos({
        bottom: window.innerHeight - rect.top + 4,
        right: window.innerWidth - rect.right,
      });
      return;
    }
    setMenuPos({
      top: rect.bottom + 4,
      right: window.innerWidth - rect.right,
    });
  }, [menuPlacement, variant]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        // Also check if clicked inside the portaled menu
        const portalMenu = document.getElementById("lang-dropdown-portal");
        if (portalMenu?.contains(e.target as Node)) return;
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  // Update position when opening
  useEffect(() => {
    if (open) updateMenuPos();
  }, [open, updateMenuPos]);

  const current = LANGUAGES.find((l) => l.id === uiLanguage) ?? LANGUAGES[0];
  const triggerClass = `inline-flex min-h-[44px] min-w-[44px] items-center gap-1.5 h-11 px-3 border border-border/50 bg-bg/50 backdrop-blur-md text-xs font-medium cursor-pointer transition-all duration-300 text-txt hover:border-accent hover:text-txt rounded-md shadow-sm ${open ? "border-accent text-txt bg-accent/5" : ""} ${triggerClassName ?? ""}`;
  const optionClass = (selected: boolean) =>
    `w-full flex items-center justify-between px-3 py-2 text-sm transition-colors hover:bg-bg-hover cursor-pointer ${selected ? "text-txt bg-accent/5 font-medium" : "text-txt"}`;
  const inlineMenuPositionClass =
    menuPlacement === "top-end"
      ? "absolute bottom-full right-0 mb-1 z-50"
      : "absolute top-full right-0 mt-1 z-50";

  const menuContent = open && (
    <ul
      id="lang-dropdown-portal"
      data-no-camera-drag="true"
      className={`w-36 rounded-lg border border-border/50 bg-bg/50 shadow-xl overflow-hidden py-1 backdrop-blur-md ${variant === "companion" ? "fixed" : inlineMenuPositionClass}`}
      style={
        variant === "companion" && menuPos
          ? {
              ...(menuPos.top !== undefined ? { top: menuPos.top } : {}),
              ...(menuPos.bottom !== undefined
                ? { bottom: menuPos.bottom }
                : {}),
              right: menuPos.right,
              zIndex: 10001,
              backdropFilter: "blur(24px)",
              WebkitBackdropFilter: "blur(24px)",
              boxShadow: "var(--shadow-lg)",
            }
          : undefined
      }
      aria-label={t?.("settings.language") ?? "Language"}
    >
      {LANGUAGES.map((lang) => (
        <li key={lang.id} role="presentation">
          <button
            type="button"
            role="option"
            aria-selected={lang.id === uiLanguage}
            className={optionClass(lang.id === uiLanguage)}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => {
              setUiLanguage(lang.id);
              setOpen(false);
            }}
            data-testid={`language-option-${lang.id}`}
          >
            <div className="flex items-center gap-2">
              <span>{lang.flag}</span>
              <span>{lang.label}</span>
            </div>
            {lang.id === uiLanguage && <Check className="w-4 h-4" />}
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <div
      ref={rootRef}
      className={`relative inline-flex shrink-0 ${className ?? ""}`}
      data-testid="language-dropdown"
      data-no-camera-drag="true"
    >
      <button
        ref={triggerRef}
        type="button"
        className={triggerClass}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t?.("settings.language") ?? "Language"}
        data-testid="language-dropdown-trigger"
      >
        <span className="text-sm leading-none">{current.flag}</span>
        <span className="hidden sm:inline uppercase tracking-widest opacity-80">
          {current.id}
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 opacity-60 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {variant === "companion" && menuContent
        ? createPortal(menuContent, document.body)
        : menuContent}
    </div>
  );
}
