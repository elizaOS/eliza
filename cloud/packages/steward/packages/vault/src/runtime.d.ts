declare module "crypto" {
  export interface BinaryLike {
    readonly byteLength: number;
  }

  export interface CipherGCM {
    update(data: string, inputEncoding: "utf8", outputEncoding: "hex"): string;
    final(outputEncoding: "hex"): string;
    getAuthTag(): Buffer;
  }

  export interface DecipherGCM {
    setAuthTag(buffer: Buffer): void;
    update(data: string, inputEncoding: "hex", outputEncoding: "utf8"): string;
    final(outputEncoding: "utf8"): string;
  }

  export function randomBytes(size: number): Buffer;
  export function scryptSync(
    password: string | Buffer,
    salt: string | Buffer,
    keylen: number,
  ): Buffer;
  export function createCipheriv(algorithm: string, key: Buffer, iv: Buffer): CipherGCM;
  export function createDecipheriv(algorithm: string, key: Buffer, iv: Buffer): DecipherGCM;
}

declare class Buffer extends Uint8Array {
  static from(data: string, encoding?: "utf8" | "hex"): Buffer;
  toString(encoding?: "utf8" | "hex"): string;
}
