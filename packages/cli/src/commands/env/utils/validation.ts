/**
 * Mask sensitive values in environment variables
 * @param value The value to mask
 * @returns The masked value
 */
export function maskedValue(value: string): string {
  if (!value) return '';

  // If the value looks like a token/API key (longer than 20 chars, no spaces), mask it
  if (value.length > 20 && !value.includes(' ')) {
    return `${value.substring(0, 4)}...${value.substring(value.length - 4)}`;
  }

  return value;
}
