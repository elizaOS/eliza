/**
 * Renders a Baileys pairing QR string into displayable forms — a terminal ASCII
 * block and a data-URL image — for the interactive QR onboarding flow.
 */
import QRCode from "qrcode";
import * as QRCodeTerminal from "qrcode-terminal";
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
