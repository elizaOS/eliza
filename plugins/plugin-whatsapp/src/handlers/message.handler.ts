import type { IWhatsAppClient } from "../clients/interface";
import type { WhatsAppMessage, WhatsAppMessageResponse } from "../types";

export class MessageHandler {
  constructor(private client: IWhatsAppClient) {}

  async send(message: WhatsAppMessage): Promise<WhatsAppMessageResponse> {
    try {
      const response = await this.client.sendMessage(message);
      if (response && typeof response === "object" && "data" in response) {
        return (response as { data: WhatsAppMessageResponse }).data;
      }
      return response as WhatsAppMessageResponse;
    } catch (error: unknown) {
      if (error instanceof Error) {
        throw new Error(`Failed to send WhatsApp message: ${error.message}`);
      }
      throw new Error("Failed to send WhatsApp message");
    }
  }
}
