import { Button } from "../ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import type { UiLanguage } from "../../i18n/messages";

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

export const LANGUAGE_DROPDOWN_TRIGGER_CLASSNAME =
  "!h-11 !min-h-11 !rounded-xl !px-3.5";

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
      ? `inline-flex h-[2.375rem] min-h-[2.375rem] min-w-0 items-center justify-center rounded-md border border-transparent !bg-transparent px-2.5 py-0 text-[11px] font-medium text-muted shadow-none ring-0 transition-colors duration-150 hover:!bg-transparent hover:text-txt active:!bg-transparent data-[state=open]:!bg-transparent ${open ? "text-accent" : ""} ${triggerClassName ?? ""}`
      : `inline-flex h-11 min-h-touch min-w-touch items-center justify-center rounded-xl px-3.5 py-0 border border-border/42 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_72%,transparent),color-mix(in_srgb,var(--bg)_44%,transparent))] text-txt shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_14px_32px_rgba(3,5,10,0.14)] ring-1 ring-inset ring-white/6 backdrop-blur-xl supports-[backdrop-filter]:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_62%,transparent),color-mix(in_srgb,var(--bg)_34%,transparent))] transition-[border-color,background-color,color,transform,box-shadow] duration-200 hover:border-accent/55 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_78%,transparent),color-mix(in_srgb,var(--bg-hover)_52%,transparent))] hover:text-txt hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_18px_36px_rgba(3,5,10,0.18)] active:scale-[0.98] disabled:active:scale-100 disabled:hover:border-border/42 disabled:hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_72%,transparent),color-mix(in_srgb,var(--bg)_44%,transparent))] disabled:hover:text-txt gap-1.5 text-xs font-medium ${open ? "border-accent/80 bg-accent/12 text-txt shadow-md" : ""} ${triggerClassName ?? ""}`;
  const contentClassName =
    variant === "titlebar"
      ? "w-40 overflow-hidden rounded-xl border border-border/70 bg-card/96 py-1 shadow-[0_18px_36px_rgba(2,8,23,0.24)] backdrop-blur-xl"
      : "w-40 overflow-hidden rounded-xl border border-border/60 bg-card/95 py-1 shadow-xl backdrop-blur-xl";

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
            aria-label={t?.("settings.language") ?? "Language"}
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
