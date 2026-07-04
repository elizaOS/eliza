/** Ambient type shim for the untyped `qrcode-terminal` dependency. */
declare module "qrcode-terminal" {
  export function generate(
    input: string,
    options?: { small?: boolean },
    callback?: (qrcode: string) => void
  ): void;
}
