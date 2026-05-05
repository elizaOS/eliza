/**
 * OSWorld benchmark type definitions.
 *
 * These types match the interface expected by the xlang-ai/OSWorld
 * evaluation framework. The benchmark uses two action spaces:
 *
 * 1. "pyautogui" — Python code strings (e.g. "pyautogui.click(100, 200)")
 * 2. "computer_13" — Structured action dicts with action_type field
 *
 * Our adapter supports both and converts them to plugin-computeruse actions.
 */

// ── Observation ─────────────────────────────────────────────────────────

export interface OSWorldObservation {
  /** Base64-encoded PNG screenshot */
  screenshot: string;
  /** Text accessibility tree of the focused window (optional) */
  accessibility_tree?: string | null;
  /** Terminal output if relevant (optional) */
  terminal?: string | null;
  /** Task instruction */
  instruction: string;
}

// ── Action Spaces ───────────────────────────────────────────────────────

/**
 * OSWorld computer_13 action types (15 enumerated actions including WAIT/DONE/FAIL).
 */
export type OSWorldActionType =
  | "CLICK"
  | "MOVE_TO"
  | "DOUBLE_CLICK"
  | "RIGHT_CLICK"
  | "SCROLL"
  | "DRAG_TO"
  | "TYPING"
  | "PRESS"
  | "KEY_DOWN"
  | "KEY_UP"
  | "HOTKEY"
  | "MOUSE_DOWN"
  | "MOUSE_UP"
  | "WAIT"
  | "DONE"
  | "FAIL";

/**
 * Structured action in the computer_13 action space.
 */
export interface OSWorldAction {
  action_type: OSWorldActionType;
  x?: number;
  y?: number;
  text?: string;
  keys?: string[];
  key?: string;
  dx?: number;
  dy?: number;
  button?: "left" | "right" | "middle";
  direction?: "up" | "down" | "left" | "right";
  amount?: number;
}

// ── Observation Types ───────────────────────────────────────────────────

export type OSWorldObservationType =
  | "screenshot"
  | "a11y_tree"
  | "screenshot_a11y_tree"
  | "som";

// ── Task Config ─────────────────────────────────────────────────────────

export interface OSWorldTaskConfig {
  id: string;
  instruction: string;
  config?: Record<string, unknown>;
  domain?: string;
  evaluator?: Record<string, unknown>;
}

// ── Step Result ─────────────────────────────────────────────────────────

export interface OSWorldStepResult {
  observation: OSWorldObservation;
  reward: number;
  done: boolean;
  info: Record<string, unknown>;
}

// ── Agent Config ────────────────────────────────────────────────────────

export interface OSWorldAgentConfig {
  /** Action space to use: "pyautogui" (code strings) or "computer_13" (structured actions) */
  actionSpace: "pyautogui" | "computer_13";
  /** Observation type */
  observationType: OSWorldObservationType;
  /** Maximum trajectory length before giving up */
  maxTrajectoryLength: number;
  /** Whether to include a11y tree in observations */
  includeA11yTree: boolean;
  /** Screenshot delay after actions (ms) */
  screenshotDelayMs: number;
}

export const DEFAULT_AGENT_CONFIG: OSWorldAgentConfig = {
  actionSpace: "computer_13",
  observationType: "screenshot",
  maxTrajectoryLength: 15,
  includeA11yTree: false,
  screenshotDelayMs: 1000,
};
