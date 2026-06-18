// Stub useActivityEvents for the home-screen e2e.
export function useActivityEvents() {
  return {
    events: [
      { id: "a1", timestamp: Date.now() - 8000, eventType: "task_complete", summary: "Shipped the chat-sheet redesign" },
      { id: "a2", timestamp: Date.now() - 95000, eventType: "tool_running", summary: "Running the Android route-coverage suite" },
      { id: "a3", timestamp: Date.now() - 600000, eventType: "reminder", summary: "Standup at 10:30" },
      { id: "a4", timestamp: Date.now() - 3600000, eventType: "workflow", summary: "Nightly backup completed" },
    ],
    clearEvents() {},
  };
}
