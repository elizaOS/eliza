/**
 * Non-component values split out of AppContext.tsx so the Provider component
 * file is not the home for runtime constants. Imported back into AppContext.tsx
 * for use inside AppProvider.
 */

/**
 * DOM event dispatched after a WebSocket reconnect so conversation views can
 * refetch their recent messages and repair state that drifted during the gap.
 * `detail.conversationId` is the active conversation at reconnect time (or null).
 */
export const RESYNC_EVENT = "elizaos:needs-resync";

export interface ResyncEventDetail {
  conversationId: string | null;
}
