import type { Plugin, ViewCapability } from "@elizaos/core";

// Shared capability manifest for every orchestrator view variant (GUI / XR /
// TUI). Declared once so the param schemas — which tell an agent driving the
// view by voice/NL what each capability accepts — stay consistent across
// variants and survive the team's ongoing view-parity churn in this file.
// Param names match exactly what runOrchestratorCapability() reads.
const ORCHESTRATOR_CAPABILITIES: ViewCapability[] = [
  { id: "orchestrator-status", description: "Get orchestrator status" },
  {
    id: "orchestrator-list-tasks",
    description: "List orchestrator task threads",
    params: {
      status: {
        type: "string",
        description: "Filter by task status (e.g. active, paused, done)",
      },
      search: { type: "string", description: "Optional search query" },
      includeArchived: {
        type: "boolean",
        description: "Include archived task threads",
      },
      limit: { type: "number", description: "Maximum threads to return" },
    },
  },
  {
    id: "orchestrator-open-task",
    description: "Open an orchestrator task thread",
    params: {
      taskId: {
        type: "string",
        description:
          "Task thread id to open; opens the most recent task when omitted",
      },
    },
  },
  {
    id: "orchestrator-create-task",
    description: "Create an orchestrator task",
    params: {
      title: { type: "string", description: "Short task title" },
      goal: {
        type: "string",
        description: "Durable goal the sub-agent works until complete",
      },
      originalRequest: {
        type: "string",
        description: "The user's original request text, if any",
      },
      kind: { type: "string", description: "Optional task kind/category" },
      priority: {
        type: "string",
        description: "Priority: low, normal, high, or urgent",
      },
      acceptanceCriteria: {
        type: "array",
        description: "List of acceptance-criteria strings",
      },
    },
  },
  {
    id: "orchestrator-pause-task",
    description: "Pause an orchestrator task",
    params: {
      taskId: { type: "string", description: "Task thread id to pause" },
    },
  },
  {
    id: "orchestrator-resume-task",
    description: "Resume an orchestrator task",
    params: {
      taskId: { type: "string", description: "Task thread id to resume" },
    },
  },
  {
    id: "orchestrator-pause-all",
    description: "Pause all active orchestrator tasks",
  },
  {
    id: "orchestrator-resume-all",
    description: "Resume all paused orchestrator tasks",
  },
  {
    id: "orchestrator-delete-task",
    description: "Delete an orchestrator task",
    params: {
      taskId: { type: "string", description: "Task thread id to delete" },
    },
  },
  {
    id: "orchestrator-fork-task",
    description: "Fork an orchestrator task",
    params: {
      taskId: { type: "string", description: "Source task thread id" },
      title: { type: "string", description: "Title for the fork" },
      goal: { type: "string", description: "Goal override for the fork" },
      priority: {
        type: "string",
        description: "Priority: low, normal, high, or urgent",
      },
      acceptanceCriteria: {
        type: "array",
        description: "List of acceptance-criteria strings",
      },
    },
  },
  {
    id: "orchestrator-add-agent",
    description: "Add a sub-agent to an orchestrator task",
    params: {
      taskId: { type: "string", description: "Target task thread id" },
      framework: {
        type: "string",
        description: "Coding agent framework (claude, codex, opencode…)",
      },
      providerSource: {
        type: "string",
        description: "Provider/subscription source for the sub-agent",
      },
      model: { type: "string", description: "Model id to use" },
      workdir: { type: "string", description: "Working directory" },
      repo: { type: "string", description: "Repository to work in" },
      label: { type: "string", description: "Display label for the agent" },
      task: { type: "string", description: "Initial task text" },
    },
  },
  {
    id: "orchestrator-stop-agent",
    description: "Stop a sub-agent on an orchestrator task",
    params: {
      taskId: { type: "string", description: "Task thread id" },
      sessionId: {
        type: "string",
        description: "Sub-agent session id to stop",
      },
    },
  },
  {
    id: "orchestrator-send-message",
    description: "Send a message to an orchestrator task",
    params: {
      taskId: { type: "string", description: "Target task thread id" },
      content: { type: "string", description: "Message content to send" },
    },
  },
];

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
    {
      id: "orchestrator",
      label: "Orchestrator",
      description: "Multi-agent task orchestration workbench",
      icon: "Layers",
      path: "/orchestrator",
      bundlePath: "dist/views/bundle.js",
      componentExport: "OrchestratorWorkbench",
      capabilities: ORCHESTRATOR_CAPABILITIES,
      tags: ["developer", "coding-agent", "orchestrator"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
    {
      id: "orchestrator",
      label: "Orchestrator XR",
      description: "Multi-agent task orchestration workbench",
      icon: "Layers",
      path: "/orchestrator",
      viewType: "xr",
      bundlePath: "dist/views/bundle.js",
      componentExport: "OrchestratorWorkbench",
      tags: ["developer", "coding-agent", "orchestrator"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
    {
      id: "orchestrator",
      label: "Orchestrator TUI",
      description: "Terminal multi-agent task orchestration workbench",
      icon: "Layers",
      path: "/orchestrator/tui",
      viewType: "tui",
      bundlePath: "dist/views/bundle.js",
      componentExport: "OrchestratorWorkbench",
      capabilities: ORCHESTRATOR_CAPABILITIES,
      tags: ["developer", "coding-agent", "orchestrator", "terminal"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
    {
      // NOTE: duplicate of the "Orchestrator XR" view above (same id/path/
      // viewType), introduced on develop by the orchestrator-view-parity work.
      // Kept to stay structurally parallel with develop; flagged for the team
      // to dedupe upstream.
      id: "orchestrator",
      label: "Orchestrator XR",
      description: "Multi-agent task orchestration workbench",
      icon: "Layers",
      path: "/orchestrator",
      viewType: "xr",
      bundlePath: "dist/views/bundle.js",
      componentExport: "OrchestratorWorkbench",
      capabilities: ORCHESTRATOR_CAPABILITIES,
      tags: ["developer", "coding-agent", "orchestrator"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};

export default taskCoordinatorPlugin;
