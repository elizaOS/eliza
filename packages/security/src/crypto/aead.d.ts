export declare const AEAD_KEY_BYTES = 32;
export declare const AEAD_NONCE_BYTES = 12;
export declare const AEAD_TAG_BYTES = 16;
export interface AeadOutput {
    ciphertext: Uint8Array;
    nonce: Uint8Array;
    authTag: Uint8Array;
}
export declare class AeadError extends Error {
    constructor(message: string);
}
export declare function aeadEncrypt(key: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): AeadOutput;
export declare function aeadDecrypt(key: Uint8Array, ciphertext: Uint8Array, nonce: Uint8Array, authTag: Uint8Array, aad?: Uint8Array): Uint8Array;
//# sourceMappingURL=aead.d.ts.map