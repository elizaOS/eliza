/**
 * UUID generation utility
 *
 * Provides a cross-browser UUID generator with fallback for older browsers
 * that don't support crypto.randomUUID() (Safari < 15.4, Chrome < 92)
 */

/**
 * Generate a UUID v4 string.
 *
 * Uses crypto.randomUUID() when available, with a cryptographically secure
 * fallback using crypto.getRandomValues() for older browsers.
 *
 * @returns A UUID v4 string
 */
export function generateUUID(): string {
  // Prefer native randomUUID when available (most modern browsers)
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }

  // Fallback: Use crypto.getRandomValues() for proper UUID v4 generation
  // Supports older browsers (Safari < 15.4, Chrome < 92, Node.js)
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.getRandomValues === 'function'
  ) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);

    // Set version (4) and variant (RFC 4122) bits
    // TypeScript doesn't infer that indices 6 and 8 exist for a 16-element array
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // Version 4
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // Variant RFC 4122

    // Convert to hex string with proper formatting
    const hex = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }

  // Last resort fallback for environments without crypto (very rare)
  // Uses timestamp + random for uniqueness (not cryptographically secure)
  const timestamp = Date.now().toString(16).padStart(12, '0');
  const random = Math.random().toString(16).substring(2, 14).padStart(12, '0');
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8, 12)}-4${random.slice(0, 3)}-8${random.slice(3, 6)}-${random.slice(6, 12)}${Date.now().toString(16).slice(-6)}`;
}
