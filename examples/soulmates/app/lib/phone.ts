const E164_REGEX = /^\+[1-9]\d{7,14}$/;

/** Normalizes phone to E.164 format (+15551234567). Returns null if invalid. */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  let normalized: string;
  if (hasPlus) {
    normalized = `+${digits}`;
  } else if (digits.length === 10) {
    normalized = `+1${digits}`;
  } else if (digits.length === 11 && digits.startsWith("1")) {
    normalized = `+${digits}`;
  } else {
    normalized = `+${digits}`;
  }

  return E164_REGEX.test(normalized) ? normalized : null;
}

export const isValidPhone = (phone: string): boolean => E164_REGEX.test(phone);

/** Formats for display: +15551234567 -> (555) 123-4567 */
export function formatPhoneDisplay(phone: string): string {
  if (!phone) return "";
  const digits = phone.replace(/\D/g, "");

  if (
    (digits.length === 11 && digits.startsWith("1")) ||
    digits.length === 10
  ) {
    const start = digits.length === 11 ? 1 : 0;
    return `(${digits.slice(start, start + 3)}) ${digits.slice(start + 3, start + 6)}-${digits.slice(start + 6)}`;
  }

  return phone;
}
