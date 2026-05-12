declare module "qrcode" {
  const QRCode: {
    toDataURL(text: string, options?: unknown): Promise<string>;
  };

  export default QRCode;
}

declare module "qrcode-terminal" {
  export function generate(
    input: string,
    options: { small?: boolean },
    callback: (output: string) => void,
  ): void;
}
