// Convert hex string to Uint8Array
/**
 * Converts a hexadecimal string to a Uint8Array.
 *
 * @param {string} hex - The hexadecimal string to convert.
 * @returns {Uint8Array} The converted Uint8Array.
 */
function hexToUint8Array(hex: string) {
  hex = hex.startsWith('0x') ? hex.slice(2) : hex;
  return new Uint8Array(hex.match(/.{1,2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
}

/**
 * Converts a Uint8Array to a hexadecimal string representation.
 *
 * @param {Uint8Array} buffer - The Uint8Array to be converted.
 * @returns {string} The hexadecimal string representation of the Uint8Array.
 */
function uint8ArrayToHex(buffer: Uint8Array) {
  return Array.from(buffer)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export { hexToUint8Array, uint8ArrayToHex };
