/**
 * UI-language picker: a flag + language-code trigger opening a checkmarked
 * dropdown of the supported `UiLanguage`s. The host owns the value —
 * `setUiLanguage` is called on select. `variant` skins it for the three mount
 * contexts (native settings, in-chat companion overlay, window titlebar); the
 * companion variant raises z-index above overlay chrome. `data-no-camera-drag`
 * exempts the control from the home-screen pan gesture.
 */

import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import type { UiLanguage } from "../../i18n/messages";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { LANGUAGES } from "./LanguageDropdown.helpers";

/** Minimal translator function type. Receive key, return string. */
export type TranslatorFn = (key: string) => string;

export interface LanguageDropdownProps {
  uiLanguage: UiLanguage;
  setUiLanguage: (language: UiLanguage) => void;
  /** Optional translator for ARIA labels */
  t?: TranslatorFn;
  /** Optional extra className on the root */
  className?: string;
  /** Optional extra className on the trigger button */
  triggerClassName?: string;
  variant?: "native" | "companion" | "titlebar";
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

  const current = LANGUAGES.find((l) => l.id === uiLanguage) ?? LANGUAGES[0];
  const triggerClassNameResolved =
    variant === "titlebar"
      ? `inline-flex h-[2.375rem] min-h-[2.375rem] min-w-0 items-center justify-center rounded-sm border border-transparent !bg-transparent px-2.5 py-0 text-[11px] font-medium text-muted shadow-none  transition-colors duration-150 hover:!bg-transparent hover:text-txt active:!bg-transparent data-[state=open]:!bg-transparent ${open ? "text-accent" : ""} ${triggerClassName ?? ""}`
      : `inline-flex h-11 min-h-touch min-w-touch items-center justify-center rounded-sm px-3.5 py-0 border border-border/42 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_72%,transparent),color-mix(in_srgb,var(--bg)_44%,transparent))] text-txt    transition-[border-color,background-color,color,transform,box-shadow] duration-200 hover:border-accent/55 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_78%,transparent),color-mix(in_srgb,var(--bg-hover)_52%,transparent))] hover:text-txt active:scale-[0.98] disabled:active:scale-100 disabled:hover:border-border/42 disabled:hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_72%,transparent),color-mix(in_srgb,var(--bg)_44%,transparent))] disabled:hover:text-txt gap-1.5 text-xs font-medium ${open ? "border-accent/80 bg-accent/12 text-txt " : ""} ${triggerClassName ?? ""}`;
  const contentClassName =
    variant === "titlebar"
      ? "w-40 overflow-hidden rounded-sm border border-border/70 bg-card/96 py-1"
      : "w-40 overflow-hidden rounded-sm border border-border/60 bg-card/95 py-1";

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
            className={triggerClassNameResolved}
            onPointerDown={(event) => event.stopPropagation()}
            aria-label={`${t?.("settings.language") ?? "Language"}: ${current.label ?? current.id}`}
            data-testid="language-dropdown-trigger"
          >
            <span className="text-sm leading-none">{current.flag}</span>
            <span
              className={
                variant === "titlebar"
                  ? "uppercase tracking-[0.14em] opacity-80"
                  : "hidden sm:inline uppercase tracking-widest opacity-80"
              }
            >
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
          className={contentClassName}
          style={
            variant === "companion"
              ? {
                  zIndex: 10001,
                }
              : undefined
          }
          data-no-camera-drag="true"
        >
          {LANGUAGES.map((lang) => (
            <DropdownMenuItem
              key={lang.id}
              className={`flex min-h-[40px] items-center justify-between px-3 py-2 text-sm transition-colors cursor-pointer ${lang.id === uiLanguage ? "bg-accent/10 text-txt font-medium" : "text-txt"}`}
              onPointerDown={(event: React.PointerEvent) =>
                event.stopPropagation()
              }
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
