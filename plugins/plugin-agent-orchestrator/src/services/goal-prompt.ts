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

/**
 * Capability fence for goal tasks that build and monetize an Eliza Cloud app.
 * Extends the coding capabilities with the parent-agent Cloud command bridge so
 * a `/goal` sub-agent can drive the create-app → deploy → monetize → buy-domain
 * loop. Paid Cloud commands are still gated server-side and by the broker's
 * capped self-spend allowance (see `spend-allowance.ts`).
 */
export const ECONOMICS_GOAL_CAPABILITIES: readonly string[] = [
  "read/search files",
  "edit/apply patches",
  "run shell/test commands",
  "inspect git diff/status",
  "communicate with the parent/swarm",
  "use the parent-agent Cloud command bridge (USE_SKILL parent-agent)",
  "create & configure Eliza Cloud apps (apps.create, apps.update, apps.monetization.update)",
  "deploy app containers and read container quota/billing (containers.create, containers.quota)",
  "search, buy, and attach domains (domains.search, domains.check, domains.buy, domains.attach)",
  "create app charges & x402 payment requests (apps.charges.*, x402.requests.*)",
  "read credits, earnings, and redemption balances (credits.*, redemptions.*)",
];

/** Named capability fences a goal task can run under. */
export type GoalCapabilityProfile = "default" | "economics";

/** Resolve a capability profile name to its allow-list. Unknown / undefined
 * profiles fall back to the coding-only default fence. */
export function resolveGoalCapabilities(
  profile?: GoalCapabilityProfile,
): readonly string[] {
  return profile === "economics"
    ? ECONOMICS_GOAL_CAPABILITIES
    : DEFAULT_GOAL_CAPABILITIES;
}

/** Coerce an untyped value (e.g. a task metadata field) to a known profile, or
 * `undefined` when it is not a recognized profile name. */
export function coerceGoalCapabilityProfile(
  value: unknown,
): GoalCapabilityProfile | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "economics") return "economics";
  if (normalized === "default") return "default";
  return undefined;
}

export interface GoalPromptInput {
  /** The distinct person-name this sub-agent is given on spawn, so it knows its
   * own identity within the swarm (the way the main agent is named). */
  agentName: string;
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
  /** Named capability fence to apply when `allowedCapabilities` is not given.
   * Defaults to `"default"` (the coding-only fence). */
  capabilityProfile?: GoalCapabilityProfile;
  /** Explicit capability fence; overrides {@link GoalPromptInput.capabilityProfile}
   * and defaults to {@link DEFAULT_GOAL_CAPABILITIES}. */
  allowedCapabilities?: readonly string[];
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
  "If you are blocked or need input, write the question as your reply text and stop — no routing-kind labels or banners; the orchestrator classifies routing from the session event, not your prose.",
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
  const profile = input.capabilityProfile ?? "default";
  const capabilities = [
    ...(input.allowedCapabilities ?? resolveGoalCapabilities(profile)),
  ];
  const sections: string[] = [
    "--- Goal ---",
    `You are ${input.agentName.trim()}, an autonomous coding sub-agent working as part of a swarm on a durable orchestrator task. Keep working until the goal is met or you are genuinely blocked.`,
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
    sections.push("--- Rooms ---", roomLines.join("\n"));
  }

  const capabilityLine =
    profile === "default"
      ? `Use only coding-relevant capabilities: ${capabilities.join(", ")}.`
      : `You are authorized to use these capabilities for this task: ${capabilities.join(", ")}. Stay within them — do not reach for unrelated tools.`;
  sections.push(
    "--- Capabilities ---",
    capabilityLine,
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
