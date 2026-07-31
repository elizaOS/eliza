/**
 * Localized country metadata and deterministic flag asset paths for phone inputs.
 *
 * Flag artwork is served from the homepage itself so rendering does not depend
 * on the host operating system's regional-indicator emoji support.
 */
import { getCountries, getCountryCallingCode } from "libphonenumber-js";

export interface CountryOption {
  code: string;
  name: string;
  dialCode: string;
}

const COUNTRY_CODES = getCountries();

export function getCountryFlagPath(countryCode: string): string | null {
  const normalized = countryCode.toUpperCase();
  return /^[A-Z]{2}$/.test(normalized)
    ? `/country-flags/${normalized}.svg`
    : null;
}

export function createCountryOptions(locale: string): CountryOption[] {
  const displayNames =
    typeof Intl.DisplayNames === "function"
      ? new Intl.DisplayNames([locale], { type: "region" })
      : null;

  return COUNTRY_CODES.map((code) => ({
    code,
    name: displayNames?.of(code) ?? code,
    dialCode: getCountryCallingCode(code),
  })).sort((a, b) => a.name.localeCompare(b.name, locale));
}
