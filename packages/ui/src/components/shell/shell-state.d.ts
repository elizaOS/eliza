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
export type ShellPhase = "booting" | "idle" | "summoned" | "listening" | "responding";
export interface ShellMessage {
    id: string;
    role: "user" | "assistant";
    content: string;
    createdAt: number;
}
export interface ShellState {
    phase: ShellPhase;
    messages: readonly ShellMessage[];
    isOnline: boolean;
    lastError: string | null;
}
export type ShellAction = {
    type: "BOOT_READY";
} | {
    type: "OPEN";
} | {
    type: "CLOSE";
} | {
    type: "SEND";
    text: string;
} | {
    type: "RESPONSE_DELTA";
    delta: string;
} | {
    type: "RESPONSE_DONE";
} | {
    type: "RESPONSE_ERROR";
    error: string;
} | {
    type: "NETWORK";
    isOnline: boolean;
};
export declare const initialShellState: ShellState;
export declare function shellReducer(state: ShellState, action: ShellAction): ShellState;
//# sourceMappingURL=shell-state.d.ts.map