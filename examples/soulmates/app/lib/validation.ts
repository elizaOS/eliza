const EMAIL_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export function validateEmail(email: string): string | null {
  const trimmed = email?.trim();
  if (!trimmed) return null;
  if (trimmed.length > 254) return "Email must be 254 characters or less.";
  if (!EMAIL_REGEX.test(trimmed)) return "Enter a valid email address.";

  const [local, domain] = trimmed.split("@");
  if (!local || local.length > 64)
    return "Email local part must be 64 characters or less.";
  if (!domain || domain.length > 253)
    return "Email domain must be 253 characters or less.";
  if (trimmed.includes("..")) return "Email cannot contain consecutive dots.";
  if (!domain.includes(".")) return "Email domain must include a valid TLD.";

  return null;
}

export function normalizeEmail(email: string): string | null {
  const trimmed = email?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

export function validateName(name: string): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  if (trimmed.length > 255) return "Name must be 255 characters or less.";
  if (/[<>{}[\]\\]/.test(trimmed)) return "Name contains invalid characters.";
  return null;
}

export function validateLocation(location: string): string | null {
  const trimmed = location?.trim();
  if (!trimmed) return null;
  if (trimmed.length > 255) return "Location must be 255 characters or less.";
  return null;
}

export type ValidationResult = {
  valid: boolean;
  errors: Record<string, string>;
};

export function validateProfileUpdate(data: {
  name?: string | null;
  email?: string | null;
  location?: string | null;
}): ValidationResult {
  const errors: Record<string, string> = {};

  const nameErr = data.name != null ? validateName(data.name) : null;
  const emailErr = data.email != null ? validateEmail(data.email) : null;
  const locationErr =
    data.location != null ? validateLocation(data.location) : null;

  if (nameErr) errors.name = nameErr;
  if (emailErr) errors.email = emailErr;
  if (locationErr) errors.location = locationErr;

  return { valid: Object.keys(errors).length === 0, errors };
}
