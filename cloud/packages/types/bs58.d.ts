declare module "bs58" {
  const bs58: {
    encode(buffer: Uint8Array | Buffer): string;
    decode(str: string): Uint8Array;
  };
  export default bs58;
}
