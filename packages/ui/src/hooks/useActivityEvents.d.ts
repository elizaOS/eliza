/**
 * Hook that subscribes to WebSocket activity events and maintains a ring buffer
 * of recent entries for the chat widget rail.
 */
export interface ActivityEvent {
    id: string;
    timestamp: number;
    eventType: string;
    sessionId?: string;
    summary: string;
}
/**
 * Subscribe to task/proactive websocket events plus assistant activity events,
 * returning a capped list of recent activity entries.
 */
export declare function useActivityEvents(): {
    readonly events: ActivityEvent[];
    readonly clearEvents: () => void;
};
//# sourceMappingURL=useActivityEvents.d.ts.map