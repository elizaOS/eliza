import QRCode from "qrcode";
import QRCodeTerminal from "qrcode-terminal";
import type { QRCodeData } from "../types";

export class QRCodeGenerator {
  async generate(qrString: string): Promise<QRCodeData> {
    return {
      terminal: await this.generateTerminal(qrString),
      dataURL: await QRCode.toDataURL(qrString),
      raw: qrString,
    };
  }

  private async generateTerminal(qr: string): Promise<string> {
    return new Promise((resolve) => {
      QRCodeTerminal.generate(qr, { small: true }, (output: string) => {
        resolve(output);
      });
    });
  }
}
