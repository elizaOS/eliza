export type KeyKind = 'raw-256' | 'raw-384' | 'ed25519' | 'secp256k1';

export interface GenerateKeyPayload {
  key_id: string;
  kind: KeyKind;
}

export interface GenerateKeyResponse {
  key: string;
}
