// Ambient module declarations for untyped dependencies used by this plugin.
//
// Keep this as a `.ts` file because plugin source `.d.ts` files are ignored as
// stray declaration emit, while these hand-authored declarations must be tracked.

declare module "qrcode-terminal" {
  export type GenerateOptions = {
    small?: boolean;
  };

  export function generate(
    input: string,
    options: GenerateOptions,
    callback: (output: string) => void,
  ): void;
}
