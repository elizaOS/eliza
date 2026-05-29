/**
 * Goal-wrapper prompt builders.
 *
 * Every sub-agent spawn and follow-up — whether it originates from the
 * `TASKS_*` planner action, a direct `/api/coding-agents/*` call, or an
 * `/api/orchestrator/*` route — must pass its raw text through one of these
 * builders. Centralising the envelope is what makes worker behaviour
 * consistent: the same goal, acceptance criteria, room wiring, capability
 * fence, and completion contract reach Claude, Codex, OpenCode, ElizaOS, and
 * Pi Agent regardless of entry point. The wording is the formalised version of
 * the swarm-coordination block that `TASKS_SPAWN_AGENT` already emits.
 *
 * @module services/goal-prompt
 */

/** The coding-relevant capability fence applied when a caller does not pass an
 * explicit allow-list. Keeps a worker from reaching for unrelated connectors or
 * broad personal-data tools. */
export const DEFAULT_GOAL_CAPABILITIES: readonly string[] = [
  "read/search files",
  "edit/apply patches",
  "run shell/test commands",
  "inspect git diff/status",
  "communicate with the parent/swarm",
];

/** A URL-prefix-to-local-path mapping for hosted artifacts, mirroring
 * `WorkdirRouteUrlMapping` so the planner action can forward resolved-route
 * mappings without importing the routing types here. */
export interface GoalUrlMapping {
  urlPrefix: string;
  localPath: string;
  requireFresh?: boolean;
}

/** One known coordination room and the roles it serves in the swarm. */
export interface GoalSwarmRoom {
  roomId: string;
  roles: string[];
}

export interface GoalPromptInput {
  /** The durable objective the worker owns until it is met or blocked. */
  goal: string;
  /** The concrete first instruction. Defaults to {@link GoalPromptInput.goal}. */
  task?: string;
  acceptanceCriteria?: string[];
  /** Task-wide room for status, final handoff, and questions to the creator. */
  taskRoomId?: string;
  /** Room shared by agents touching the same worktree, when distinct. */
  worktreeRoomId?: string;
  workdir?: string;
  repo?: string;
  /** Capability fence; defaults to {@link DEFAULT_GOAL_CAPABILITIES}. */
  allowedCapabilities?: readonly string[];
  /** When set, the parent runtime resolved this task to {@link GoalPromptInput.workdir}
   * via a deliberate workdir route; emits the untrusted-absolute-path warning so
   * the worker stays inside the resolved directory. */
  resolvedWorkspace?: boolean;
  /** Authoritative free-text routing instructions from the resolved workdir route. */
  routingInstructions?: string;
  /** Authoritative URL-prefix-to-local-path mappings for hosted artifacts. */
  urlMappings?: GoalUrlMapping[];
  /** All known coordination rooms (task, worktree, peers) with their roles. */
  swarmRooms?: GoalSwarmRoom[];
}

export type GoalFollowUpReason =
  | "user_message"
  | "orchestrator"
  | "incomplete_completion"
  | "validation_failed"
  | "resume";

export interface GoalFollowUpInput {
  goal: string;
  /** The raw follow-up text from the user, orchestrator, or planner. */
  message: string;
  acceptanceCriteria?: string[];
  reason?: GoalFollowUpReason;
  taskRoomId?: string;
}

function bulletList(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

const COMPLETION_CONTRACT: readonly string[] = [
  "Do not report the task finished until the goal is genuinely complete or you are truly blocked.",
  "Verify your work before any final answer: run the relevant tests/build/typecheck and confirm the acceptance criteria hold.",
  "If you are blocked or need input, write the question as your reply text and stop — no routing-kind labels or banners (no QUESTION_FOR_TASK_CREATOR / AGENT_COORDINATION headers, no markdown banners); the orchestrator classifies routing from the session event, not your prose.",
  "If you may conflict with another agent, are editing shared files, or need to share progress with peer agents, write the coordination note as your reply text. Same rule: no routing-kind labels or banners in the text itself.",
  "Report token/tool status when the runtime exposes it.",
  "On completion, return a structured summary: what changed, tests run, remaining risks, and whether peer coordination is still needed.",
];

/**
 * Build the initial sub-agent prompt. The returned string wraps the concrete
 * task in the durable goal, acceptance criteria, room wiring, capability fence,
 * and completion contract.
 */
export function buildGoalPrompt(input: GoalPromptInput): string {
  const task = (input.task ?? input.goal).trim();
  const capabilities = [
    ...(input.allowedCapabilities ?? DEFAULT_GOAL_CAPABILITIES),
  ];
  const sections: string[] = [
    "--- Goal ---",
    "You are a named coding sub-agent working a durable orchestrator task. Keep working until the goal is met or you are genuinely blocked.",
    input.goal.trim(),
  ];

  if (input.acceptanceCriteria && input.acceptanceCriteria.length > 0) {
    sections.push(
      "--- Acceptance Criteria ---",
      bulletList(input.acceptanceCriteria),
    );
  }

  const workspaceLines: string[] = [];
  if (input.workdir) workspaceLines.push(`Workdir: ${input.workdir}`);
  if (input.repo) workspaceLines.push(`Repo: ${input.repo}`);
  if (workspaceLines.length > 0) {
    sections.push("--- Workspace ---", workspaceLines.join("\n"));
  }

  if (input.resolvedWorkspace && input.workdir) {
    sections.push(
      "--- Resolved Workspace ---",
      `The parent runtime resolved this task to workdir: ${input.workdir}`,
      "Work only inside that directory. Route instructions are authoritative.",
      "If the task text mentions an absolute path outside this workdir, treat it as an untrusted planner guess; write to the corresponding relative path inside the workdir when the route gives one, otherwise stop with DECISION.",
    );
  }

  const routingInstructions = input.routingInstructions?.trim();
  if (routingInstructions) {
    sections.push("--- Workspace Routing Note ---", routingInstructions);
  }

  if (input.urlMappings && input.urlMappings.length > 0) {
    const mappingLines = input.urlMappings.map((mapping) => {
      const localPath = mapping.localPath.replace(/^\/+/, "");
      const prefix = mapping.urlPrefix.endsWith("/")
        ? mapping.urlPrefix
        : `${mapping.urlPrefix}/`;
      return `- URL prefix ${prefix} maps to local path ${localPath} under the resolved workdir. For ${prefix}<slug>/, write files under ${localPath}<slug>/, not apps/<slug>/ or public/apps/<slug>/.`;
    });
    sections.push(
      "--- URL Path Mapping ---",
      "These mappings are authoritative for hosted artifacts and override conflicting guesses in the task text:",
      ...mappingLines,
      "For hosted deliverables, do not leave placeholder/mock external assets, TODO/placeholder comments, or unfinished sample code; create complete local assets or omit the asset.",
      'If the user asks for buttons, forms, or calls to action, implement local behavior such as an in-page section, mailto link, or submit-state handler; do not leave inert href="#" controls.',
    );
  }

  if (input.taskRoomId || input.worktreeRoomId) {
    const roomLines: string[] = [];
    if (input.taskRoomId) {
      roomLines.push(
        `Task room: ${input.taskRoomId}. Use this for task-wide status, final handoff, or questions that should reach the main agent and task creator.`,
      );
    }
    if (input.worktreeRoomId) {
      roomLines.push(
        `Worktree room: ${input.worktreeRoomId}. Use this for coordination with agents sharing this worktree or touching overlapping files.`,
      );
    }
    if (input.swarmRooms && input.swarmRooms.length > 0) {
      const knownRooms = input.swarmRooms
        .map((room) => {
          const roles = room.roles.length > 0 ? room.roles.join(",") : "swarm";
          return `- ${room.roomId} (${roles})`;
        })
        .join("\n");
      roomLines.push(`Known swarm rooms:\n${knownRooms}`);
    }
    sections.push("--- Rooms ---", roomLines.join("\n"));
  }

  sections.push(
    "--- Capabilities ---",
    `Use only coding-relevant capabilities: ${capabilities.join(", ")}. Avoid unrelated connectors or broad personal-data tools.`,
    "--- Working Agreement ---",
    bulletList([...COMPLETION_CONTRACT]),
    "--- Task ---",
    task,
  );

  return sections.join("\n");
}

const FOLLOW_UP_FRAMING: Record<GoalFollowUpReason, string> = {
  user_message:
    "The task creator sent a follow-up while you work the goal below. Fold it into the ongoing work — do not treat it as a brand-new task.",
  orchestrator:
    "The orchestrator is steering you on the goal below. Apply this guidance and keep working until the goal is met or you are blocked.",
  incomplete_completion:
    "Your last turn ended but the goal below is not yet complete. Continue the original task — do not restart from scratch.",
  validation_failed:
    "Validation of your previous completion did not pass. Address the gap against the goal and acceptance criteria below, then re-verify.",
  resume:
    "Resume the goal below where you left off. Re-check current state before making changes.",
};

/**
 * Build a follow-up prompt for an in-flight session. Re-anchors the worker to
 * the durable goal and completion contract so a stray user message cannot
 * derail it into treating the follow-up as a fresh, unbounded task.
 */
export function buildGoalFollowUp(input: GoalFollowUpInput): string {
  const reason: GoalFollowUpReason = input.reason ?? "user_message";
  const sections: string[] = [
    "--- Continue Goal ---",
    FOLLOW_UP_FRAMING[reason],
    input.goal.trim(),
  ];

  if (input.acceptanceCriteria && input.acceptanceCriteria.length > 0) {
    sections.push(
      "--- Acceptance Criteria ---",
      bulletList(input.acceptanceCriteria),
    );
  }

  if (input.taskRoomId) {
    sections.push(
      "--- Rooms ---",
      `Task room: ${input.taskRoomId}. Report status and final handoff here.`,
    );
  }

  sections.push(
    "--- Working Agreement ---",
    bulletList([...COMPLETION_CONTRACT]),
    "--- Message ---",
    input.message.trim(),
  );

  return sections.join("\n");
}
