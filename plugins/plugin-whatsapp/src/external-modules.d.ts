declare module "qrcode" {
  const QRCode: {
    toDataURL(text: string, options?: unknown): Promise<string>;
  };

  export default QRCode;
}
