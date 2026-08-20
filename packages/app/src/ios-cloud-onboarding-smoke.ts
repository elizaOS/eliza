/**
 * Pure helpers for the iOS cloud-onboarding smoke lane (#16936): the smoke
 * request contract between the simulator harness and the in-app verifier, and
 * the fail-closed reply-selection rules the verifier applies to assistant
 * rows. Kept free of app imports so the unit suite can exercise them directly
 * (the coverage bar in #16936 names this parsing); `main.tsx` consumes them
 * inside `runIosCloudOnboardingSmokeIfRequested` / `driveIosLivenessChatTurn`.
 */

/**
 * Extract the run-unique liveness challenge token from a challenge prompt
 * produced by `buildLivenessChallenge` in `test/liveness-contract.mjs`. The
 * harness — never the client — owns token generation; the driver mirrors the
 * harness-side rule only so it can wait for the row that actually echoes this
 * run's token instead of accepting the first non-empty row.
 *
 * @param prompt the challenge prompt the harness wrote into the smoke request
 * @returns the lowercase token ("" when the prompt carries no challenge)
 */
export function extractIosLivenessChallengeToken(prompt: string): string {
  const marker = "Reply with exactly this code to confirm you are live: ";
  const at = prompt.lastIndexOf(marker);
  if (at === -1) return "";
  return prompt
    .slice(at + marker.length)
    .trim()
    .toLowerCase();
}

/**
 * Decide whether an assistant row holds a real reply rather than the pending
 * turn placeholder. The overlay marks its assistant-turn body
 * `data-phase="status"` while the turn is pending (a "Thinking" placeholder
 * occupies the row) and `"reply"` once real content exists, so that marker is
 * authoritative wherever it appears (renderer authority:
 * packages/ui/src/components/shell/chat-overlay-transcript.tsx,
 * `OverlayAssistantTurnBody`). Surfaces without the marker render their
 * pending-turn indicator outside any assistant-attributed row —
 * `ChatSurface` swaps the TypingIndicator in *for* the empty-assistant bubble
 * (no `data-role` row exists), and `ChatTranscript` appends it as a sibling
 * after the message list — so a row matching the assistant selector there is
 * always a real, completed message and counts.
 */
export function isIosLivenessReplyRow(
  row: Element | undefined | null,
): boolean {
  if (!row) return false;
  const body = row.querySelector('[data-testid="overlay-assistant-turn-body"]');
  if (body) return body.getAttribute("data-phase") === "reply";
  return true;
}

/** The smoke request the harness writes before launching the app. */
export interface IosCloudOnboardingSmokeRequest {
  mode: "tap" | "autologin";
  /**
   * Liveness contract (#14359 / #16936): liveness is intrinsic to every SIWE
   * cloud-onboarding lane, so the request carries only the prompt — there is
   * no opt-out field. A bare request ("1") still drives the real turn.
   */
  livenessPrompt: string;
}

/** State the in-app verifier must prove before reporting onboarding complete. */
export interface IosCloudOnboardingCompletionState {
  homeVisible: boolean;
  composerVisible: boolean;
  onboardingHidden: boolean;
  cloudActiveServer: boolean;
  firstRunPostCount: number;
}

/**
 * Enforce the direct-Cloud completion contract shared with the Android lane.
 * A provisioned Cloud agent is already the chat runtime, so posting the
 * app-shell `/api/first-run` endpoint to that base is an architecture error;
 * durable client state and the authenticated Cloud server prove completion.
 */
export function isIosCloudOnboardingComplete(
  state: IosCloudOnboardingCompletionState,
): boolean {
  return (
    state.homeVisible &&
    state.composerVisible &&
    state.onboardingHidden &&
    state.cloudActiveServer &&
    state.firstRunPostCount === 0
  );
}

const DEFAULT_LIVENESS_PROMPT = "In one short sentence, say hello.";

/**
 * Parse the raw smoke-request blob. A missing or bare ("1") request runs the
 * default tap lane with the default prompt; a corrupt JSON blob cannot drive a
 * valid path and throws.
 */
export function parseIosCloudOnboardingSmokeRequest(
  raw: string | null,
): IosCloudOnboardingSmokeRequest {
  const fallback: IosCloudOnboardingSmokeRequest = {
    mode: "tap",
    livenessPrompt: DEFAULT_LIVENESS_PROMPT,
  };
  if (!raw || raw === "1") return fallback;
  try {
    const parsed = JSON.parse(raw) as {
      mode?: unknown;
      livenessPrompt?: unknown;
    };
    return {
      mode: parsed.mode === "autologin" ? "autologin" : fallback.mode,
      livenessPrompt:
        typeof parsed.livenessPrompt === "string" &&
        parsed.livenessPrompt.trim()
          ? parsed.livenessPrompt.trim()
          : fallback.livenessPrompt,
    };
  } catch (error) {
    // error-policy:J2 corrupt smoke-request blob cannot drive a valid path
    throw new Error("Invalid iOS cloud-onboarding smoke request", {
      cause: error,
    });
  }
}
