/** Privacy-preserving country selection and E.164 normalization for phone sign-in. */

import {
  type CountryCode,
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
} from "libphonenumber-js/min";

export interface PhoneCountryOption {
  code: CountryCode;
  dialCode: string;
  name: string;
}

const COUNTRY_CODES = getCountries();
const COUNTRY_CODE_SET = new Set<string>(COUNTRY_CODES);
const COUNTRY_NAMES =
  typeof Intl !== "undefined" && typeof Intl.DisplayNames === "function"
    ? new Intl.DisplayNames(["en"], { type: "region" })
    : null;

function countryName(code: CountryCode): string {
  try {
    return COUNTRY_NAMES?.of(code) ?? code;
  } catch {
    return code;
  }
}

export const PHONE_COUNTRY_OPTIONS: PhoneCountryOption[] = COUNTRY_CODES.map(
  (code) => ({
    code,
    dialCode: getCountryCallingCode(code),
    name: countryName(code),
  }),
).sort((left, right) => left.name.localeCompare(right.name));

/**
 * Use the browser's declared locale region without requesting location or
 * calling an IP-lookup service. Time zones are deliberately not used because
 * many span multiple countries. US is the deterministic fallback.
 */
export function inferPhoneCountry(
  languages: readonly string[] = typeof navigator === "undefined"
    ? []
    : [...navigator.languages, navigator.language],
): CountryCode {
  for (const language of languages) {
    try {
      const region = new Intl.Locale(language).region?.toUpperCase();
      if (region && COUNTRY_CODE_SET.has(region)) {
        return region as CountryCode;
      }
    } catch {
      // error-policy:J3 malformed browser locale; try the next declaration.
    }
  }
  return "US";
}

/** Accept either a national number for the selected country or explicit E.164. */
export function normalizePhoneForCountry(
  value: string,
  country: CountryCode,
): string | null {
  const parsed = parsePhoneNumberFromString(value.trim(), country);
  return parsed?.isValid() ? parsed.number : null;
}
