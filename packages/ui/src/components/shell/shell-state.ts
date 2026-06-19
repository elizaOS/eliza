import type { ChatFailureKind } from "../../api";

/**
 * Shell phase for the device-shell foundation (HomePill + AssistantOverlay +
 * ChatSurface). Drives the pill's visual treatment.
 *
 *   booting    — startup not ready; pill dim, no halo.
 *   idle       — ready, no overlay; pill solid.
 *   summoned   — overlay open, no active mic/response; faint halo.
 *   listening  — push-to-talk capture in flight; red pulse.
 *   responding — agent stream in flight; ambient glow.
 */
export type ShellPhase =
  | "booting"
  | "idle"
  | "summoned"
  | "listening"
  | "responding";

export interface ShellMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  /** Set on assistant turns the server flagged as failed (e.g. no provider). */
  failureKind?: ChatFailureKind;
  /** Agent reasoning/thought for this turn, rendered as a collapsed block. */
  reasoning?: string;
}
