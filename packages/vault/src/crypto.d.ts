/**
 * AES-256-GCM envelope for a single value.
 *
 * Wire format: `v1:<nonce_b64>:<tag_b64>:<ct_b64>` (all base64).
 *   - nonce: 12 bytes (96-bit GCM standard)
 *   - tag:   16 bytes (128-bit auth tag)
 *
 * The vault key is bound as additional authenticated data (AAD) so a
 * swapped ciphertext between slots fails decryption.
 */
export declare const KEY_BYTES = 32;
export declare class CryptoError extends Error {
    constructor(message: string);
}
export declare function generateMasterKey(): Buffer;
export declare function encrypt(masterKey: Buffer, plaintext: string, aad: string): string;
export declare function decrypt(masterKey: Buffer, ciphertext: string, aad: string): string;
//# sourceMappingURL=crypto.d.ts.map