import type { EventEmitter } from "node:events";
import type { ConnectionStatus, WhatsAppMessage } from "../types";

export interface IWhatsAppClient extends EventEmitter {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(message: WhatsAppMessage): Promise<unknown>;
  verifyWebhook?(token: string): Promise<boolean>;
  getConnectionStatus(): ConnectionStatus;
}
