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

export function useRoutableViews() {
  return {
    views: [
      {
        id: "chat",
        label: "Chat",
        path: "/chat",
        viewType: "gui",
        available: true,
        pluginName: "@elizaos/builtin",
        builtin: true,
        visibleInManager: false,
        viewKind: "release",
      },
      {
        id: "views",
        label: "Views",
        path: "/views",
        viewType: "gui",
        available: true,
        pluginName: "@elizaos/builtin",
        builtin: true,
        visibleInManager: false,
        viewKind: "release",
      },
      {
        id: "settings",
        label: "Settings",
        path: "/settings",
        icon: "Settings",
        viewType: "gui",
        available: true,
        pluginName: "@elizaos/builtin",
        builtin: true,
        visibleInManager: false,
        viewKind: "release",
      },
      {
        id: "notes",
        label: "Notes",
        path: "/notes",
        icon: "Notebook",
        viewType: "gui",
        available: true,
        pluginName: "@elizaos/plugin-notes",
        visibleInManager: true,
        viewKind: "release",
      },
      {
        id: "tasks",
        label: "Tasks",
        path: "/tasks",
        icon: "ListTodo",
        viewType: "gui",
        available: true,
        pluginName: "@elizaos/builtin",
        builtin: true,
        visibleInManager: false,
        viewKind: "release",
      },
      {
        id: "files",
        label: "Files",
        path: "/files",
        icon: "FileText",
        viewType: "gui",
        available: true,
        pluginName: "@elizaos/builtin",
        builtin: true,
        visibleInManager: false,
        viewKind: "release",
      },
    ],
    loading: false,
    error: null,
    refresh: () => {},
  };
}
