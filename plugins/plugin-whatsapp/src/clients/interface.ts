/**
 * The direct Baileys client contract: lifecycle, message send, and connection
 * status. Implementors emit inbound messages as EventEmitter events.
 */
import type { EventEmitter } from "node:events";
import type { ConnectionStatus, WhatsAppMessage } from "../types";

export interface IWhatsAppClient extends EventEmitter {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(message: WhatsAppMessage): Promise<unknown>;
  getConnectionStatus(): ConnectionStatus;
}
