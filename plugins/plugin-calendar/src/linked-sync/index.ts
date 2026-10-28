/**
 * Browser-safe explicit local-first Google Calendar sync for phone and browser
 * clients: owner/source-bound checkpoints, the Cloud `calendar/sync-v1`
 * provider port, the serialized review/enable/pause/sync controller, the
 * foreground host that keeps the owner's opt-in and schedules passes, and the
 * read-only reader of one owner-chosen Google calendar. Hosts inject storage,
 * the local calendar port and the Cloud transport.
 */
export * from "./google-reader.ts";
export * from "./google-sync-port.ts";
export * from "./linked-store.ts";
export * from "./sync-controller.ts";
export * from "./sync-host.ts";
