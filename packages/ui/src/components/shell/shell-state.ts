/**
 * Shell state machine for the device-shell foundation (HomePill +
 * AssistantOverlay + ChatSurface).
 *
 * Five phases:
 *   booting    — StartupShell phase != "ready". Pill renders dim, no halo.
 *   idle       — Ready, no overlay. Pill renders solid, no halo.
 *   summoned   — Overlay open, no active mic/response. Pill renders faint halo.
 *   listening  — Reserved for the push-to-talk follow-up sub-project. Pill
 *                renders red pulse.
 *   responding — Agent stream in flight. Pill renders ambient glow.
 */
export type ShellPhase =
  | "booting"
  | "idle"
  | "summoned"
  | "listening"
  | "responding";

import type { ChatFailureKind } from "../../api";

export interface ShellMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  /** Set on assistant turns the server flagged as failed (e.g. no provider). */
  failureKind?: ChatFailureKind;
}

export interface ShellState {
  phase: ShellPhase;
  messages: readonly ShellMessage[];
  isOnline: boolean;
  lastError: string | null;
}

export type ShellAction =
  | { type: "BOOT_READY" }
  | { type: "OPEN" }
  | { type: "CLOSE" }
  | { type: "SEND"; text: string }
  | { type: "RESPONSE_DELTA"; delta: string }
  | { type: "RESPONSE_DONE" }
  | { type: "RESPONSE_ERROR"; error: string }
  | { type: "NETWORK"; isOnline: boolean };

export const initialShellState: ShellState = {
  phase: "booting",
  messages: [],
  isOnline: true,
  lastError: null,
};

function nextId(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function shellReducer(
  state: ShellState,
  action: ShellAction,
): ShellState {
  switch (action.type) {
    case "BOOT_READY":
      return state.phase === "booting" ? { ...state, phase: "idle" } : state;
    case "OPEN":
      return state.phase === "idle" ? { ...state, phase: "summoned" } : state;
    case "CLOSE":
      return state.phase === "summoned" ||
        state.phase === "listening" ||
        state.phase === "responding"
        ? { ...state, phase: "idle" }
        : state;
    case "SEND": {
      if (state.phase !== "summoned" && state.phase !== "listening") {
        return state;
      }
      const text = action.text.trim();
      if (!text) return state;
      const userMessage: ShellMessage = {
        id: nextId(),
        role: "user",
        content: text,
        createdAt: Date.now(),
      };
      const assistantPlaceholder: ShellMessage = {
        id: nextId(),
        role: "assistant",
        content: "",
        createdAt: Date.now(),
      };
      return {
        ...state,
        phase: "responding",
        messages: [...state.messages, userMessage, assistantPlaceholder],
      };
    }
    case "RESPONSE_DELTA": {
      if (state.phase !== "responding") return state;
      const messages = state.messages.slice();
      const last = messages[messages.length - 1];
      if (!last || last.role !== "assistant") return state;
      messages[messages.length - 1] = {
        ...last,
        content: last.content + action.delta,
      };
      return { ...state, messages };
    }
    case "RESPONSE_DONE":
      return state.phase === "responding"
        ? { ...state, phase: "summoned", lastError: null }
        : state;
    case "RESPONSE_ERROR":
      return state.phase === "responding"
        ? { ...state, phase: "summoned", lastError: action.error }
        : state;
    case "NETWORK":
      return state.isOnline === action.isOnline
        ? state
        : { ...state, isOnline: action.isOnline };
    default: {
      // Exhaustiveness check — unreachable when ShellAction stays in sync.
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}
