// Stub useActivityEvents for the home-screen e2e.
//
// The home ranker boosts a widget when a recent activity event maps to one of
// its `signalKinds`. The per-plugin cards for inbox (`message`/`approval`),
// relationships (`nudge`/`approval`), and health (`check-in`) only rank into the
// capped home grid once such activity exists — mirroring the device, where a
// fresh unread thread / dormant-contact nudge / sleep check-in is exactly what
// floats those cards up. Seed one event per kind so every seeded per-plugin
// widget surfaces.
export function useActivityEvents() {
  return {
    events: [
      { id: "a1", timestamp: Date.now() - 8000, eventType: "task_complete", summary: "Shipped the chat-sheet redesign" },
      { id: "a2", timestamp: Date.now() - 95000, eventType: "tool_running", summary: "Running the Android route-coverage suite" },
      { id: "a3", timestamp: Date.now() - 600000, eventType: "reminder", summary: "Standup at 10:30" },
      { id: "a4", timestamp: Date.now() - 3600000, eventType: "workflow", summary: "Nightly backup completed" },
      { id: "a5", timestamp: Date.now() - 20000, eventType: "message_received", summary: "Alex Rivera: bring the deck" },
      { id: "a6", timestamp: Date.now() - 30000, eventType: "approval", summary: "Approve the pending merge" },
      { id: "a7", timestamp: Date.now() - 40000, eventType: "nudge", summary: "Reconnect with a dormant contact" },
      // Health only subscribes to `check-in` (the lowest weight) and has the
      // lowest base priority, so stack a few recent sleep check-ins to lift it
      // over the home-grid cap — as sustained irregular-sleep flags would.
      { id: "a8", timestamp: Date.now() - 50000, eventType: "check-in", summary: "Sleep check-in" },
      { id: "a9", timestamp: Date.now() - 60000, eventType: "check-in", summary: "Bedtime drifted late again" },
      { id: "a10", timestamp: Date.now() - 70000, eventType: "check-in", summary: "Wake time irregular" },
    ],
    clearEvents() {},
  };
}
