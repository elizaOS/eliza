/**
 * Client message ids of chat turns this renderer is still streaming. A pending
 * receipt for a live turn belongs to that send, not to draft recovery.
 */

const liveChatTurns = new Set<string>();

export function addLiveChatTurn(clientMessageId: string): void {
  liveChatTurns.add(clientMessageId);
}

export function deleteLiveChatTurn(clientMessageId: string): void {
  liveChatTurns.delete(clientMessageId);
}

export function isLiveChatTurn(clientMessageId: string): boolean {
  return liveChatTurns.has(clientMessageId);
}
