/**
 * The transport-agnostic client contract shared by the Cloud API and Baileys
 * clients: lifecycle (start/stop), message send, optional webhook verification,
 * and connection status. Implementors emit inbound messages as EventEmitter events.
 */
import type { EventEmitter } from "node:events";
import type { ConnectionStatus, WhatsAppMessage } from "../types";

export interface IWhatsAppClient extends EventEmitter {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(message: WhatsAppMessage): Promise<unknown>;
  verifyWebhook?(token: string): Promise<boolean>;
  getConnectionStatus(): ConnectionStatus;
}
