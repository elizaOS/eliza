/**
 * LanguageDropdown — language selector used in the app header and settings.
 *
 * Fully props-driven; no app context dependency. Takes the current language
 * and a setter from the caller. Works in both "native" and "companion"
 * visual variants.
 *
 * Uses DropdownMenu from @elizaos/app-core (Radix) for portaling, positioning,
 * keyboard navigation, and outside-click dismissal.
 */

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@elizaos/app-core";
import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import type { UiLanguage } from "../../i18n/messages";
import { SHELL_EXPANDED_BUTTON_CLASSNAME } from "@elizaos/app-companion";

/** Minimal translator function type. Receive key, return string. */
export type TranslatorFn = (key: string) => string;

/** Language metadata with flag emoji and native label. */
export const LANGUAGES: { id: UiLanguage; flag: string; label: string }[] = [
  { id: "en", flag: "\u{1F1FA}\u{1F1F8}", label: "English" },
  { id: "zh-CN", flag: "\u{1F1E8}\u{1F1F3}", label: "\u4E2D\u6587" },
  { id: "ko", flag: "\u{1F1F0}\u{1F1F7}", label: "\uD55C\uAD6D\uC5B4" },
  { id: "es", flag: "\u{1F1EA}\u{1F1F8}", label: "Espa\u00F1ol" },
  { id: "pt", flag: "\u{1F1E7}\u{1F1F7}", label: "Portugu\u00EAs" },
  { id: "vi", flag: "\u{1F1FB}\u{1F1F3}", label: "Ti\u1EBFng Vi\u1EC7t" },
  { id: "tl", flag: "\u{1F1F5}\u{1F1ED}", label: "Tagalog" },
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

export const LANGUAGE_DROPDOWN_TRIGGER_CLASSNAME =
  "!h-11 !min-h-touch !min-w-touch !rounded-xl !px-3.5 sm:!px-3.5 leading-none";

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

  const current = LANGUAGES.find((l) => l.id === uiLanguage) ?? LANGUAGES[0];
  const triggerClass = `${SHELL_EXPANDED_BUTTON_CLASSNAME} gap-1.5 text-xs font-medium ${open ? "border-accent/80 bg-accent/12 text-txt shadow-md" : ""} ${triggerClassName ?? ""}`;

  return (
    <div
      className={`relative inline-flex shrink-0 ${className ?? ""}`}
      data-testid="language-dropdown"
      data-no-camera-drag="true"
    >
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className={triggerClass}
            onPointerDown={(event) => event.stopPropagation()}
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
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          side={menuPlacement === "top-end" ? "top" : "bottom"}
          sideOffset={4}
          className="w-40 overflow-hidden rounded-xl border border-border/60 bg-card/95 py-1 shadow-xl backdrop-blur-xl"
          style={
            variant === "companion"
              ? {
                  zIndex: 10001,
                  backdropFilter: "blur(24px)",
                  WebkitBackdropFilter: "blur(24px)",
                  boxShadow: "var(--shadow-lg)",
                }
              : undefined
          }
          data-no-camera-drag="true"
        >
          {LANGUAGES.map((lang) => (
            <DropdownMenuItem
              key={lang.id}
              className={`flex min-h-[40px] items-center justify-between px-3 py-2 text-sm transition-colors cursor-pointer ${lang.id === uiLanguage ? "bg-accent/10 text-txt font-medium" : "text-txt"}`}
              onPointerDown={(event) => event.stopPropagation()}
              onSelect={() => {
                setUiLanguage(lang.id);
              }}
              data-testid={`language-option-${lang.id}`}
            >
              <div className="flex items-center gap-2">
                <span>{lang.flag}</span>
                <span>{lang.label}</span>
              </div>
              {lang.id === uiLanguage && <Check className="w-4 h-4" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
