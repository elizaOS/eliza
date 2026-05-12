/**
 * Phone Number Normalization Utilities
 *
 * Shared utilities for phone number validation and normalization.
 * Supports E.164 format and handles various input formats.
 */

import { type CountryCode, parsePhoneNumberWithError } from "libphonenumber-js";
import { logger } from "@/lib/utils/logger";

// Validation patterns
const E164_REGEX = /^\+[1-9]\d{1,14}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const US_10_DIGIT = /^\d{10}$/;
const US_11_DIGIT = /^1\d{10}$/;

/** Validate E.164 phone number format (+X followed by 1-14 digits) */
export function isValidE164(phoneNumber: string): boolean {
  return E164_REGEX.test(phoneNumber);
}

/** Validate email format (simple check) */
export function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email);
}

/**
 * Normalize phone number to E.164 format using simple heuristics.
 * Returns null if cannot be converted. For robust parsing, use normalizePhoneNumber().
 */
export function normalizeToE164(phoneNumber: string): string | null {
  const cleaned = phoneNumber.replace(/[^\d+]/g, "");

  if (cleaned.startsWith("+")) {
    return isValidE164(cleaned) ? cleaned : null;
  }

  // Assume US/Canada for 10 or 11 digit numbers
  if (US_10_DIGIT.test(cleaned)) return `+1${cleaned}`;
  if (US_11_DIGIT.test(cleaned)) return `+${cleaned}`;

  return null;
}

/**
 * Normalize phone number or email using libphonenumber-js.
 * Returns E.164 format for phones, lowercase for emails, or cleaned input on failure.
 */
export function normalizePhoneNumber(phone: string, defaultCountry?: string): string {
  const input = phone.trim();

  // Handle email addresses (for iMessage)
  if (input.includes("@")) {
    if (!isValidEmail(input)) {
      logger.warn("[PhoneNormalization] Invalid email format", {
        email: input,
      });
    }
    return input.toLowerCase();
  }

  const country = (defaultCountry || process.env.DEFAULT_COUNTRY_CODE || "US") as CountryCode;

  try {
    const parsed = input.startsWith("+")
      ? parsePhoneNumberWithError(input)
      : parsePhoneNumberWithError(input, country);

    if (parsed?.isValid()) {
      return parsed.format("E.164");
    }

    // Best-effort format for parseable but invalid numbers
    if (parsed) {
      logger.warn("[PhoneNormalization] Using best-effort format", {
        phone: input,
        country,
      });
      return parsed.format("E.164");
    }

    logger.warn("[PhoneNormalization] Could not parse", {
      phone: input,
      country,
    });
    return input.replace(/[^\d+]/g, "");
  } catch (error) {
    logger.warn("[PhoneNormalization] Invalid phone", {
      phone: input,
      country,
      error: error instanceof Error ? error.message : "Unknown",
    });
    return input.replace(/[^\d+]/g, "");
  }
}

/**
 * Validate phone number for API requests.
 * Returns normalized phone on success, or error message on failure.
 */
export function validatePhoneForAPI(
  phoneNumber: string,
): { valid: true; normalized: string } | { valid: false; error: string } {
  const trimmed = phoneNumber.trim();

  if (!trimmed) {
    return { valid: false, error: "Phone number is required" };
  }

  const parsed = parsePhoneNumber(trimmed);

  if (!parsed || !parsed.isValid) {
    return { valid: false, error: "Invalid phone number format" };
  }

  return { valid: true, normalized: parsed.formatted };
}

/**
 * Parse phone number and return structured data.
 * Returns null if the phone number cannot be parsed.
 */
export function parsePhoneNumber(
  phone: string,
  defaultCountry?: string,
): {
  formatted: string;
  countryCode: string;
  nationalNumber: string;
  isValid: boolean;
} | null {
  const trimmedPhone = phone.trim();

  // Email addresses are not phone numbers
  if (trimmedPhone.includes("@")) {
    return null;
  }

  const country = (defaultCountry || process.env.DEFAULT_COUNTRY_CODE || "US") as CountryCode;

  try {
    const parsed = trimmedPhone.startsWith("+")
      ? parsePhoneNumberWithError(trimmedPhone)
      : parsePhoneNumberWithError(trimmedPhone, country);

    if (!parsed) {
      return null;
    }

    return {
      formatted: parsed.format("E.164"),
      countryCode: parsed.countryCallingCode || "",
      nationalNumber: parsed.nationalNumber || "",
      isValid: parsed.isValid(),
    };
  } catch {
    return null;
  }
}
