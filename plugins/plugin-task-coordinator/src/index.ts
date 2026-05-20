import type { Plugin } from "@elizaos/core";

const taskCoordinatorPlugin: Plugin = {
  name: "@elizaos/plugin-task-coordinator",
  description: "Coding agent task coordinator and session control surface.",
  views: [
    {
      id: "task-coordinator",
      label: "Task Coordinator",
      description: "Coding agent task threads, sessions, and controls",
      icon: "SquareTerminal",
      path: "/task-coordinator",
      bundlePath: "dist/views/bundle.js",
      componentExport: "CodingAgentTasksPanel",
      tags: ["developer", "coding-agent", "tasks"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
    {
      id: "task-coordinator",
      label: "Task Coordinator XR",
      description: "Coding agent task threads, sessions, and controls",
      icon: "SquareTerminal",
      path: "/task-coordinator",
      viewType: "xr",
      bundlePath: "dist/views/bundle.js",
      componentExport: "CodingAgentTasksPanel",
      tags: ["developer", "coding-agent", "tasks"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
    {
      id: "task-coordinator",
      label: "Task Coordinator TUI",
      description: "Terminal coding agent task coordinator",
      icon: "SquareTerminal",
      path: "/task-coordinator/tui",
      viewType: "tui",
      bundlePath: "dist/views/bundle.js",
      componentExport: "TaskCoordinatorTuiView",
      capabilities: [
        {
          id: "list-sessions",
          description: "List active coding-agent sessions",
        },
        {
          id: "list-task-threads",
          description: "List coding-agent task threads",
          params: {
            search: { type: "string", description: "Optional search query" },
            includeArchived: {
              type: "boolean",
              description: "Include archived task threads",
            },
            limit: { type: "number", description: "Maximum threads to return" },
          },
        },
        {
          id: "open-thread",
          description: "Open a coding-agent task thread",
          params: {
            threadId: { type: "string", description: "Task thread id" },
          },
        },
        {
          id: "stop-session",
          description: "Stop a running coding-agent session",
          params: {
            sessionId: { type: "string", description: "Session id to stop" },
          },
        },
        { id: "refresh", description: "Refresh task coordinator state" },
      ],
      tags: ["developer", "coding-agent", "tasks", "terminal"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};

export default taskCoordinatorPlugin;
export * from "./AgentTabsSection";
export * from "./CodingAgentControlChip";
export * from "./CodingAgentSettingsSection";
export * from "./CodingAgentTasksPanel";
export * from "./coding-agent-settings-shared";
export * from "./GlobalPrefsSection";
export * from "./LlmProviderSection";
export * from "./ModelConfigSection";
export * from "./PtyConsoleBase";
export * from "./PtyConsoleDrawer";
export * from "./PtyConsoleSidePanel";
export * from "./PtyTerminalPane";
export * from "./pty-status-dots";
export * from "./register-slots";
export * from "./session-hydration";
