/**
 * Plugin definition for the coding-agent task coordinator: the view manifest,
 * the orchestrator view's typed capability descriptors, and `init()`.
 *
 * Declares three views (`task-coordinator`, `orchestrator`, `cockpit`) with
 * their bundle path + component exports, and the capability list the TUI layer
 * uses to drive the orchestrator workbench. `init()` registers the
 * view-scoped `/orchestrator-status` slash command into the per-runtime
 * command registry; the deterministic handler action is the only server-side
 * runtime contribution. All task/session state is owned by
 * `@elizaos/plugin-agent-orchestrator` — this plugin is display + control only.
 */
import type { Plugin, ViewCapability } from "@elizaos/core";
import {
  orchestratorStatusCommandAction,
  registerOrchestratorCommands,
} from "./orchestrator-command";

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
    id: "orchestrator-update-task",
    description:
      "Update an orchestrator task's title, goal, summary, priority, or acceptance criteria",
    params: {
      taskId: { type: "string", description: "Task thread id to update" },
      title: { type: "string", description: "New task title" },
      goal: { type: "string", description: "New durable goal" },
      summary: { type: "string", description: "New task summary" },
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
    id: "orchestrator-validate-task",
    description: "Record a validation result for an orchestrator task",
    params: {
      taskId: { type: "string", description: "Task thread id to validate" },
      passed: { type: "boolean", description: "Whether validation passed" },
      summary: { type: "string", description: "Validation summary" },
      evidence: {
        type: "string",
        description: "Evidence supporting the result",
      },
      verifier: {
        type: "string",
        description: "Who or what performed validation",
      },
      humanOverride: {
        type: "boolean",
        description: "Whether a human explicitly overrode the result",
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
        description: "Coding agent framework (claude, codex, opencode...)",
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
  // Contribute the orchestrator view's slash command into the universal command
  // registry once the runtime is up. `@elizaos/plugin-commands` boots before app
  // plugins, so its per-runtime store already exists here (#8790).
  init: async (_config, runtime) => {
    registerOrchestratorCommands(runtime.agentId);
  },
  // Deterministic handler for the registered slash command.
  actions: [orchestratorStatusCommandAction],
  views: [
    // ONE declaration → GUI + XR + TUI, all drawn from the single
    // TaskCoordinatorView spatial source. `modalities` is a plain literal here
    // (index.ts is not in the view bundle), so no brand-new `@elizaos/core`
    // runtime export reaches the bundle build.
    {
      id: "task-coordinator",
      viewKind: "preview",
      label: "Task Coordinator",
      description: "Coding agent task threads, sessions, and controls",
      icon: "SquareTerminal",
      path: "/task-coordinator",
      modalities: ["gui", "xr", "tui"],
      bundlePath: "dist/views/bundle.js",
      // First-party instrumented view (data-agent-id controls): grant the
      // agent-surface capability so the view broker admits agent-driven
      // fills/clicks (#13452 manifest gate).
      surface: { capabilities: ["agent-surface"] },
      componentExport: "TaskCoordinatorView",
      relatedActions: ["TASKS"],
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
      tags: [
        "developer",
        "coding-agent",
        "coding",
        "build",
        "feature",
        "app builder",
        "tasks",
      ],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
    // ONE declaration → GUI + XR + TUI, all drawn from the single
    // OrchestratorView spatial source.
    {
      id: "orchestrator",
      viewKind: "developer",
      developerOnly: true,
      label: "Orchestrator",
      description: "Multi-agent task orchestration workbench",
      icon: "Layers",
      path: "/orchestrator",
      modalities: ["gui", "xr", "tui"],
      bundlePath: "dist/views/bundle.js",
      // First-party instrumented view (data-agent-id controls): grant the
      // agent-surface capability so the view broker admits agent-driven
      // fills/clicks (#13452 manifest gate).
      surface: { capabilities: ["agent-surface"] },
      componentExport: "OrchestratorView",
      relatedActions: ["TASKS"],
      capabilities: ORCHESTRATOR_CAPABILITIES,
      tags: ["developer", "coding-agent", "orchestrator"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
    // The coding cockpit: shaw's live task-room deck + a per-session mode
    // picker, composed into one mobile-first GUI view. Dev-gated (normies never
    // see it). The CockpitRoute container wires it to the live orchestrator.
    {
      id: "cockpit",
      viewKind: "developer",
      developerOnly: true,
      label: "Cockpit",
      description: "Mobile-first coding cockpit — your agents on one screen",
      icon: "TerminalSquare",
      path: "/cockpit",
      modalities: ["gui", "xr"],
      bundlePath: "dist/views/bundle.js",
      // First-party instrumented view (data-agent-id controls): grant the
      // agent-surface capability so the view broker admits agent-driven
      // fills/clicks (#13452 manifest gate).
      surface: { capabilities: ["agent-surface"] },
      componentExport: "CockpitRoute",
      // The cockpit drives the same orchestrator interact protocol (list /
      // open-task / create-task / add-agent / stop-agent …) as /orchestrator,
      // so it advertises the same capabilities — this is what lets app-control
      // route session-control intents ("stop that agent") to the cockpit.
      capabilities: ORCHESTRATOR_CAPABILITIES,
      tags: ["developer", "coding-agent", "cockpit"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};

export default taskCoordinatorPlugin;
export {
  ORCHESTRATOR_STATUS_COMMAND_ACTION,
  ORCHESTRATOR_STATUS_COMMAND_KEY,
  ORCHESTRATOR_VIEW_ID,
  orchestratorStatusCommandAction,
  registerOrchestratorCommands,
} from "./orchestrator-command";
