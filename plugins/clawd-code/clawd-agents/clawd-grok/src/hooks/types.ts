export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "PreCompact",
  "PostCompact",
  "Notification",
  "InstructionsLoaded",
  "CwdChanged",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

// --- Hook Input types (piped to stdin as JSON) ---

export interface BaseHookInput {
  hook_event_name: HookEvent;
  session_id?: string;
  cwd: string;
}

export interface PreToolUseHookInput extends BaseHookInput {
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface PostToolUseHookInput extends BaseHookInput {
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_output: Record<string, unknown>;
}

export interface PostToolUseFailureHookInput extends BaseHookInput {
  hook_event_name: "PostToolUseFailure";
  tool_name: string;
  tool_input: Record<string, unknown>;
  error: string;
}

export interface UserPromptSubmitHookInput extends BaseHookInput {
  hook_event_name: "UserPromptSubmit";
  user_prompt: string;
}

export interface SessionStartHookInput extends BaseHookInput {
  hook_event_name: "SessionStart";
  source: "startup" | "resume" | "clear";
}

export interface SessionEndHookInput extends BaseHookInput {
  hook_event_name: "SessionEnd";
}

export interface StopHookInput extends BaseHookInput {
  hook_event_name: "Stop";
}

export interface StopFailureHookInput extends BaseHookInput {
  hook_event_name: "StopFailure";
  error: string;
}

export interface SubagentStartHookInput extends BaseHookInput {
  hook_event_name: "SubagentStart";
  agent_type: string;
  description: string;
}

export interface SubagentStopHookInput extends BaseHookInput {
  hook_event_name: "SubagentStop";
  agent_type: string;
  description: string;
  success: boolean;
}

export interface TaskCreatedHookInput extends BaseHookInput {
  hook_event_name: "TaskCreated";
  agent_type: string;
  description: string;
}

export interface TaskCompletedHookInput extends BaseHookInput {
  hook_event_name: "TaskCompleted";
  agent_type: string;
  description: string;
  success: boolean;
}

export interface PreCompactHookInput extends BaseHookInput {
  hook_event_name: "PreCompact";
  trigger: "auto" | "manual";
}

export interface PostCompactHookInput extends BaseHookInput {
  hook_event_name: "PostCompact";
  trigger: "auto" | "manual";
}

export interface NotificationHookInput extends BaseHookInput {
  hook_event_name: "Notification";
  message: string;
}

export interface InstructionsLoadedHookInput extends BaseHookInput {
  hook_event_name: "InstructionsLoaded";
  files_loaded: number;
}

export interface CwdChangedHookInput extends BaseHookInput {
  hook_event_name: "CwdChanged";
  old_cwd: string;
  new_cwd: string;
}

export type HookInput =
  | PreToolUseHookInput
  | PostToolUseHookInput
  | PostToolUseFailureHookInput
  | UserPromptSubmitHookInput
  | SessionStartHookInput
  | SessionEndHookInput
  | StopHookInput
  | StopFailureHookInput
  | SubagentStartHookInput
  | SubagentStopHookInput
  | TaskCreatedHookInput
  | TaskCompletedHookInput
  | PreCompactHookInput
  | PostCompactHookInput
  | NotificationHookInput
  | InstructionsLoadedHookInput
  | CwdChangedHookInput;

// --- Hook Output types (parsed from stdout JSON) ---

export interface HookOutput {
  continue?: boolean;
  stopReason?: string;
  decision?: "approve" | "block";
  reason?: string;
  additionalContext?: string;
}

// --- Hook Result (after processing exit code + output) ---

export type HookOutcome = "success" | "blocking" | "non_blocking_error" | "cancelled";

export interface HookResult {
  outcome: HookOutcome;
  output?: HookOutput;
  stderr?: string;
  exitCode: number | null;
  command: string;
}

export interface AggregatedHookResult {
  blocked: boolean;
  blockingErrors: Array<{ command: string; stderr: string }>;
  preventContinuation: boolean;
  stopReason?: string;
  additionalContexts: string[];
  decision?: "approve" | "block";
  results: HookResult[];
}

// --- Hook Configuration types ---

export interface CommandHook {
  type: "command";
  command: string;
  timeout?: number;
}

export type HookCommand = CommandHook;

export interface HookMatcher {
  matcher?: string;
  hooks: HookCommand[];
}

export type HooksConfig = Partial<Record<HookEvent, HookMatcher[]>>;

/**
 * Returns the matcher query field for a given hook event input,
 * used to filter matchers by their `matcher` string.
 */
export function getMatchQuery(input: HookInput): string | undefined {
  switch (input.hook_event_name) {
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure":
      return input.tool_name;
    case "SessionStart":
      return input.source;
    case "SubagentStart":
    case "SubagentStop":
    case "TaskCreated":
    case "TaskCompleted":
      return input.agent_type;
    case "PreCompact":
    case "PostCompact":
      return input.trigger;
    default:
      return undefined;
  }
}
