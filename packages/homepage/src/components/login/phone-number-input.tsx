import { getCountries, getCountryCallingCode } from "libphonenumber-js";
import { ChevronDown } from "lucide-react";
import { useMemo } from "react";
import { CountryFlag } from "@/components/login/country-flag";
import { Input } from "@/components/ui/input";

// ============================================================================
// Country helpers
// ============================================================================

const COUNTRY_LIST = getCountries();
const DISPLAY_NAMES =
  typeof Intl !== "undefined"
    ? new Intl.DisplayNames(["en"], { type: "region" })
    : null;

function getCountryName(code: string): string {
  try {
    return DISPLAY_NAMES?.of(code) ?? code;
  } catch {
    return code;
  }
}

export interface CountryOption {
  code: string;
  name: string;
  dialCode: string;
}

/**
 * Hook to get a sorted list of country options for the phone input.
 */
export function useCountryOptions(): CountryOption[] {
  return useMemo(() => {
    return COUNTRY_LIST.map((code) => {
      let dialCode = "1";
      try {
        dialCode = getCountryCallingCode(code);
      } catch {
        // fallback
      }
      return { code, name: getCountryName(code), dialCode };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }, []);
}

/**
 * Build a full E.164-ish phone number from country + local number.
 */
export function buildFullPhoneNumber(
  phoneValue: string,
  selectedCountry: string,
  countryOptions: CountryOption[],
): string {
  const dialCode =
    countryOptions.find((c) => c.code === selectedCountry)?.dialCode || "1";
  const cleanPhone = phoneValue.replace(/\D/g, "");
  return `+${dialCode}${cleanPhone}`;
}

// ============================================================================
// Component
// ============================================================================

type PhoneInputVariant = "light" | "dark";

interface PhoneNumberInputProps {
  /** Country code (e.g. "US") */
  selectedCountry: string;
  onCountryChange: (country: string) => void;
  /** Local phone number (without country code) */
  phoneValue: string;
  onPhoneChange: (value: string) => void;
  /** Called when the user presses Enter */
  onSubmit?: () => void;
  /** Visual variant: "light" for get-started page, "dark" for connected page */
  variant?: PhoneInputVariant;
  /** Auto-focus the input */
  autoFocus?: boolean;
  /** Country options list (from useCountryOptions hook) */
  countryOptions: CountryOption[];
}

const variantStyles = {
  light: {
    wrapper:
      "w-full flex items-center rounded-xl border border-neutral-300 bg-white/50 backdrop-blur-sm overflow-hidden focus-within:ring-1 focus-within:ring-neutral-400 focus-within:border-neutral-400 transition-colors",
    label:
      "relative flex h-14 shrink-0 cursor-pointer items-center gap-2 pl-3 pr-2 text-neutral-600 hover:text-neutral-900",
    flag: "size-6 rounded-sm overflow-hidden shrink-0 pointer-events-none",
    chevron: "size-4 shrink-0 pointer-events-none text-neutral-400",
    select:
      "absolute inset-0 cursor-pointer appearance-none bg-transparent opacity-0",
    input:
      "rounded-none border-0 bg-transparent text-neutral-900 placeholder:text-neutral-400 focus-visible:ring-0 focus-visible:ring-offset-0 h-14 px-4 text-base flex-1 min-w-0",
  },
  dark: {
    wrapper:
      "w-full flex items-center rounded-xl border border-white/10 bg-white/5 overflow-hidden focus-within:ring-1 focus-within:ring-white/20 focus-within:border-white/20 transition-colors",
    label:
      "relative flex h-12 shrink-0 cursor-pointer items-center gap-2 pl-3 pr-2 text-white/60 hover:text-white/80",
    flag: "size-5 rounded-sm overflow-hidden shrink-0 pointer-events-none",
    chevron: "size-3.5 shrink-0 pointer-events-none text-white/30",
    // The select needs to be visible for the dropdown options to be readable on dark backgrounds
    select:
      "absolute inset-0 cursor-pointer appearance-none bg-transparent opacity-0",
    input:
      "rounded-none border-0 bg-transparent text-white placeholder:text-white/30 focus-visible:ring-0 focus-visible:ring-offset-0 h-12 px-3 text-sm flex-1 min-w-0",
  },
} as const;

/**
 * Shared phone number input with country code selector.
 *
 * Supports two visual variants:
 * - "light": for the get-started onboarding pages (light glassmorphism background)
 * - "dark": for the connected page (dark background)
 */
export function PhoneNumberInput({
  selectedCountry,
  onCountryChange,
  phoneValue,
  onPhoneChange,
  onSubmit,
  variant = "light",
  autoFocus = false,
  countryOptions,
}: PhoneNumberInputProps) {
  const styles = variantStyles[variant];

  return (
    <div className={styles.wrapper}>
      <label className={styles.label}>
        <CountryFlag countryCode={selectedCountry} className={styles.flag} />
        <ChevronDown className={styles.chevron} />
        {/*
          The <select> is absolutely positioned over the label so
          clicking anywhere on the flag/chevron opens the native dropdown.
          We keep it transparent but set a dark background on <option>
          so dropdown text is always readable regardless of page theme.
        */}
        <select
          value={selectedCountry}
          onChange={(e) => onCountryChange(e.target.value)}
          className={styles.select}
          aria-label="Choose country"
          style={{ color: "initial" }}
        >
          {countryOptions.map((opt) => (
            <option
              key={opt.code}
              value={opt.code}
              className="bg-white text-neutral-900 dark:bg-neutral-800 dark:text-white"
              style={{ backgroundColor: "#1a1a1c", color: "#ffffff" }}
            >
              {opt.name} (+{opt.dialCode})
            </option>
          ))}
        </select>
      </label>
      <Input
        type="tel"
        placeholder="(000) 000-0000"
        value={phoneValue}
        onChange={(e) => onPhoneChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onSubmit) {
            onSubmit();
          }
        }}
        className={styles.input}
        aria-label="Phone number"
        autoFocus={autoFocus}
      />
    </div>
  );
}
