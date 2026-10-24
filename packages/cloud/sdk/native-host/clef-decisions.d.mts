/**
 * Types for `clef-decisions.mjs`. See that file for the contract; its exports
 * are annotated with these types and checked by `tsc -p native-host`.
 */

export declare const CLEF_DECISIONS_PATH: "/api/v1/decisions";

/** Request limits. Larger requests are rejected, never truncated. */
export declare const CLEF_DECISION_LIMITS: {
  readonly goal: 2000;
  readonly page: 16000;
  readonly candidates: 16;
  readonly candidateId: 64;
  readonly candidateLabel: 300;
  readonly action: 1000;
  readonly context: 4000;
  readonly transcript: 2000;
  readonly recentTurns: 6;
};

/** Option id Cloud adds to every choice: no candidate fits the goal. */
export declare const CLEF_NO_CHOICE: "none";

export type ActionMode = "tell" | "ask";

export interface ClefChoiceCandidate {
  /** Stable id from the caller's snapshot, such as a node id. */
  id: string;
  /** What the person sees: visible text, role and nearby label. */
  label: string;
}

export interface ClefTurn {
  speaker: "person" | "assistant";
  text: string;
}

export type ClefDecisionRequest =
  | {
      kind: "choice";
      /** The person's goal in plain words, for example "pay the electric bill". */
      goal: string;
      /** Visible page text for context. Leave out secret values. */
      page?: string;
      candidates: ClefChoiceCandidate[];
    }
  | {
      kind: "mode";
      /** The planned action in plain words, for example "Click Pay $84.20". */
      action: string;
      context?: string;
    }
  | {
      kind: "turn";
      /** What the person has said so far in this turn. */
      transcript: string;
      /** The last few turns, oldest first. */
      recentTurns?: ClefTurn[];
    };

export type ClefDecisionResult =
  | {
      status: "ok";
      kind: "choice";
      model: string;
      /** The best candidate id, or null when "none fits" is most likely. */
      choice: string | null;
      /** Clef's certainty in its pick, 0 to 1. */
      confidence: number;
      /** Probability per candidate id plus {@link CLEF_NO_CHOICE}; sums to 1. */
      probabilities: Record<string, number>;
    }
  | {
      status: "ok";
      kind: "mode";
      model: string;
      /** A suggestion only: combine it with the floor. */
      suggestedMode: ActionMode;
      askProbability: number;
    }
  | {
      status: "ok";
      kind: "turn";
      model: string;
      complete: boolean;
      completeProbability: number;
    };

export type ClefDecisionResponse =
  | ClefDecisionResult
  | { status: "unavailable"; reason: "disabled" | "provider_error" };

/** `ask` from Clef at this probability or above: a doubtful action asks. */
export declare const CLEF_ASK_THRESHOLD: 0.3;
/** A turn is complete at this probability or above. */
export declare const CLEF_TURN_COMPLETE_THRESHOLD: 0.5;

/**
 * The mode to use: the floor's `ask` always stands; a suggestion can only
 * raise `tell` to `ask`. A missing suggestion keeps the floor.
 */
export declare function combineActionMode(
  floor: ActionMode,
  suggestion: ActionMode | null | undefined,
): ActionMode;

/**
 * Offline fallback for `turn`: a turn that trails off ("and", "um", "so"),
 * ends on a connecting word or an unfinished number is not complete.
 */
export declare function turnLooksComplete(transcript: string): boolean;

/** Request checks shared by Cloud and clients; returns a reason or null. */
export declare function clefDecisionRequestProblem(
  request: ClefDecisionRequest,
): string | null;

export interface ClefDecisionsClientOptions {
  /** Cloud base URL, for example https://www.elizacloud.ai */
  baseUrl: string;
  /** Adds the caller's own Cloud authorization to each request. */
  headers: () => Record<string, string> | Promise<Record<string, string>>;
  fetch?: typeof fetch;
  /** Ends a request, including headers and body, after this many milliseconds as `unavailable`. */
  timeoutMs?: number;
  /**
   * Called on each `unavailable` answer with the HTTP status, or null when
   * no usable response came (network error, timeout, or a body cut off), so
   * a caller can back off. Never called for a caller abort.
   */
  onUnavailable?: (status: number | null) => void;
}

/**
 * Calls the Cloud route. Network and server failures become `unavailable`;
 * an abort through `signal` rejects with its reason.
 */
export declare function createClefDecisionsClient(
  options: ClefDecisionsClientOptions,
): (
  request: ClefDecisionRequest,
  signal?: AbortSignal,
) => Promise<ClefDecisionResponse>;
