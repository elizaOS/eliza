declare module "qrcode" {
  interface QRCodeToCanvasOptions {
    width?: number;
    margin?: number;
    color?: {
      dark?: string;
      light?: string;
    };
  }

  export function toCanvas(
    canvas: HTMLCanvasElement,
    text: string,
    options?: QRCodeToCanvasOptions,
  ): Promise<void>;

  export function toDataURL(
    text: string,
    options?: QRCodeToCanvasOptions,
  ): Promise<string>;
}
