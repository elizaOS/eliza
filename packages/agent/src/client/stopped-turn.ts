// spec/agent/client/turns.md, "A stopped turn's user row is found by its clientMessageId alone, and only its own answer releases it"
import { findStopped } from "../../gen/agent__client__turns.ts";

export type ClientMessageId = string & { readonly __brand: "ClientMessageId" };

export interface HistoryMessage {
  readonly role: string;
  readonly clientMessageId?: string;
}

/** @throws {never} */
export function newClientMessageId(): ClientMessageId {
  if (typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID() as ClientMessageId;
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as ClientMessageId;
}

/** @throws {never} */
export function findStoppedUserTurn<M extends HistoryMessage>(messages: readonly M[], clientMessageId: ClientMessageId): M | undefined {
  const rows = messages.map((message, at) => ({ message: at + 1, fromOwner: message.role === "user", clientMessageId: message.clientMessageId === clientMessageId ? 1 : 0 }));
  const found = findStopped(rows, 1);
  return found === 0 ? undefined : messages[found - 1];
}
