// Stub for useAvailableViews in the home-screen e2e: report the view paths the
// home tiles gate on as registered, so the gated tiles (orchestrator,
// workflows, inbox) render deterministically.
export function useAvailableViews() {
  return {
    views: [
      { id: "orchestrator", path: "/orchestrator" },
      { id: "automations", path: "/automations" },
      { id: "inbox", path: "/inbox" },
    ],
    loading: false,
  };
}
