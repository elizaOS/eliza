export type WalkthroughPhase =
  | "idle"
  | "observing"
  | "planning"
  | "acting"
  | "verifying"
  | "paused_handoff"
  | "completed"
  | "blocked"
  | "failed";

export type HandoffKind =
  | "NeedsPrivateSignIn"
  | "NeedsMFA"
  | "NeedsCaptcha"
  | "NeedsFileUpload"
  | "NeedsCommitApproval"
  | "NeedsUserDisambiguation"
  | "NeedsUntrustedOriginApproval";

export type ConsequenceClass =
  | "observe"
  | "navigate"
  | "stage"
  | "commit"
  | "person_only";

export type DarkPatternKind =
  | "pre-checked-opt-in"
  | "recurring-default"
  | "paid-default-addon"
  | "sponsored-listing"
  | "upsell-modal"
  | "confirmshaming";

export interface DarkPatternFlag {
  readonly kind: DarkPatternKind;
  readonly ref?: string;
  readonly dismissRef?: string;
  readonly targetSelector?: string;
  readonly label?: string | null;
  readonly text: string;
}

export interface ElementConsequenceResult {
  readonly consequenceClass: ConsequenceClass;
  readonly reasons: readonly string[];
  readonly requiresGrant: boolean;
  readonly handoffKind?: HandoffKind;
}

export interface WalkthroughGoal {
  readonly id?: string;
  readonly instruction: string;
  readonly constraints?: readonly string[];
  readonly allowedOrigins?: readonly string[];
  readonly allowSameSiteSubdomains?: boolean;
  readonly maxSteps?: number;
  readonly maxStagnantSteps?: number;
  readonly maxRepeatedActionAttempts?: number;
  readonly autoDismissBlockers?: boolean;
  readonly requireApprovalForCommit?: boolean;
}

export type PlannerAction = (
  | { readonly kind: "click"; readonly ref: string; readonly reason: string; readonly expectedEffect?: string }
  | { readonly kind: "fill"; readonly ref: string; readonly text: string; readonly reason: string }
  | { readonly kind: "select"; readonly ref: string; readonly text: string; readonly reason: string }
  | { readonly kind: "scroll"; readonly direction: "up" | "down" | "left" | "right"; readonly ref?: string; readonly reason: string }
  | { readonly kind: "follow"; readonly ref: string; readonly reason: string; readonly expectedEffect?: string }
  | { readonly kind: "dismiss_blocker"; readonly blockerIndex?: number; readonly reason: string }
  | { readonly kind: "go_back"; readonly reason: string }
  | { readonly kind: "request_handoff"; readonly handoffKind: HandoffKind; readonly summary: string; readonly ref?: string; readonly details?: Record<string, unknown>; readonly reason: string }
  | { readonly kind: "ask_user"; readonly question: string; readonly options: readonly string[]; readonly reason: string }
  | { readonly kind: "request_host_port"; readonly port: "file_upload" | "observe_download" | "calendar_reminder" | "verification_channel"; readonly payload: Record<string, unknown>; readonly reason: string }
  | { readonly kind: "complete"; readonly summary: string; readonly quotes: readonly string[]; readonly extractedFacts?: Record<string, unknown> }
  | { readonly kind: "block"; readonly reason: string; readonly handoffKind?: HandoffKind }
) & { readonly note?: string };

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface PlannerResult {
  readonly action: PlannerAction | null;
  readonly parseError?: string;
  readonly latencyMs?: number;
  readonly tokenUsage?: TokenUsage | null;
}

export interface WalkthroughPlanner {
  plan(input: Record<string, unknown>): Promise<PlannerResult>;
}

export interface BrowserTransport {
  snapshot(options?: { readonly structuredRegions?: boolean; readonly statementRegions?: boolean; readonly taskPolicy?: unknown }): Promise<Record<string, unknown>>;
  execute(command: Record<string, unknown>): Promise<Record<string, unknown>>;
  navigate?(url: string): Promise<void>;
  goBack?(): Promise<void>;
}

export interface WalkthroughHandoff {
  readonly kind: HandoffKind;
  readonly summary: string;
  readonly targetSelector?: string | null;
  readonly targetOrigin?: string;
  readonly targetLabel?: string;
  readonly urlOriginPath?: string;
  readonly accept?: string | null;
  readonly multiple?: boolean;
  readonly options?: readonly string[];
  readonly details?: Record<string, unknown>;
  readonly text?: string;
}

export interface HandoffResolution {
  readonly kind: "approved" | "rejected" | "cancelled" | "pause";
  readonly approved?: boolean;
  readonly commitGrant?: Record<string, unknown>;
  readonly humanCompleted?: boolean;
  readonly answer?: string;
  readonly allowOrigin?: string;
  readonly reason?: string;
}

export interface TrajectoryTelemetryEvent {
  readonly timestamp: string;
  readonly runId: string;
  readonly stepIndex: number;
  readonly phase: WalkthroughPhase;
  readonly urlOriginPath: string;
  readonly domRevision: number;
  readonly candidateCount: number;
  readonly blockerKinds: readonly string[];
  readonly darkPatternFlags: readonly string[];
  readonly plannerActionKind: string | null;
  readonly targetLabel: string | null;
  readonly consequenceClass: ConsequenceClass | null;
  readonly gateVerdict: string;
  readonly handoffKind: HandoffKind | null;
  readonly readbackVerified: boolean | null;
  readonly domChanged: boolean | null;
  readonly urlChanged: boolean | null;
  readonly latencyMs: number;
  readonly tokenUsage: TokenUsage | null;
  readonly detail?: string;
}

export interface HostCapabilityPorts {
  onHandoff?(handoff: WalkthroughHandoff): Promise<HandoffResolution>;
  requestFileUpload?(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  observeDownload?(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  proposeCalendarReminder?(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  lookupVerificationChannel?(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  checkOriginSafety?(url: string): Promise<{ readonly safe: boolean; readonly reason?: string }>;
  issueCommitGrant?(details: Record<string, unknown>): Promise<{ readonly approved: boolean; readonly commitGrant?: Record<string, unknown>; readonly humanCompleted?: boolean }>;
  onTelemetry?(event: TrajectoryTelemetryEvent): void | Promise<void>;
}

export interface WalkthroughStepOutcome {
  readonly status: "continue" | "paused" | "completed" | "blocked" | "failed";
  readonly phase: WalkthroughPhase;
  readonly stepIndex: number;
  readonly handoff?: WalkthroughHandoff;
  readonly summary?: string;
  readonly quotes?: readonly string[];
  readonly extractedFacts?: Record<string, unknown> | null;
  readonly quotesVerified?: boolean;
  readonly reason?: string;
  readonly telemetryEvent?: TrajectoryTelemetryEvent;
  readonly state: WalkthroughState;
}

export interface WalkthroughState {
  readonly runId: string;
  readonly phase: WalkthroughPhase;
  readonly stepIndex: number;
  readonly maxSteps: number;
  readonly stagnantSteps: number;
  readonly urlOriginPath: string;
  readonly pendingHandoff: WalkthroughHandoff | null;
  readonly history: readonly Record<string, unknown>[];
  readonly memoryNotes: readonly string[];
  readonly allowedOrigins: readonly string[];
}

export interface WalkthroughEngine {
  step(): Promise<WalkthroughStepOutcome>;
  resume(resolution?: HandoffResolution): Promise<WalkthroughStepOutcome>;
  run(): Promise<WalkthroughStepOutcome>;
  getState(): WalkthroughState;
  getTelemetry(): readonly TrajectoryTelemetryEvent[];
  getTelemetryJsonl(): string;
}

export interface OpenAICompatiblePlannerConfig {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly retryBaseDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly responseFormat?: "json_object" | Record<string, unknown> | null;
  readonly disableReasoning?: boolean;
  readonly reasoningEffort?: string;
  readonly extraBody?: Record<string, unknown>;
  readonly extraHeaders?: Record<string, string>;
  readonly systemPromptSuffix?: string;
}

export const WALKTHROUGH_PHASES: readonly WalkthroughPhase[];
export const HANDOFF_KINDS: readonly HandoffKind[];
export const CONSEQUENCE_CLASSES: readonly ConsequenceClass[];

export function redactSensitiveText(input: string): string;
export function stripUrlQuery(rawUrl: string): string;
export function isOriginAllowed(
  targetUrl: string,
  options?: {
    readonly currentOrigin?: string;
    readonly allowedOrigins?: readonly string[];
    readonly allowSameSiteSubdomains?: boolean;
  },
): boolean;
export function classifyElementConsequence(
  element: Record<string, unknown>,
  options?: {
    readonly action?: "click" | "fill" | "select" | "scroll" | "follow";
    readonly hasPaymentCredentialField?: boolean;
    readonly commitPattern?: RegExp | string | null;
  },
): ElementConsequenceResult;
export function detectDarkPatterns(snapshot: Record<string, unknown>): readonly DarkPatternFlag[];
export function sanitizeObservationForPlanner(
  snapshot: Record<string, unknown>,
  options?: {
    readonly maxTextChars?: number;
    readonly maxControls?: number;
    readonly maxCards?: number;
    readonly maxTableRows?: number;
    readonly includeReadOnly?: boolean;
  },
): {
  readonly observation: Record<string, unknown>;
  readonly refToElement: Map<string, Record<string, unknown>>;
  readonly rawIdToShortRef: Map<string, string>;
  readonly hasPaymentCredentialField: boolean;
};
export function parsePlannerAction(
  raw: unknown,
): { readonly ok: true; readonly action: PlannerAction } | { readonly ok: false; readonly error: string };
export function verifyCompletionQuotes(
  quotes: readonly string[],
  snapshotOrCorpus: Record<string, unknown> | readonly (Record<string, unknown> | string)[],
): { readonly verified: boolean; readonly matched: readonly string[]; readonly missing: readonly string[] };
export function formatTelemetryJsonl(events: readonly TrajectoryTelemetryEvent[]): string;
export function createOpenAICompatiblePlanner(config: OpenAICompatiblePlannerConfig): WalkthroughPlanner;
export function createWalkthroughEngine(config: {
  readonly goal: WalkthroughGoal;
  readonly transport: BrowserTransport;
  readonly planner: WalkthroughPlanner;
  readonly ports?: HostCapabilityPorts;
  readonly options?: {
    readonly sanitize?: {
      readonly maxTextChars?: number;
      readonly maxControls?: number;
      readonly maxCards?: number;
      readonly maxTableRows?: number;
      readonly includeReadOnly?: boolean;
    };
  };
}): WalkthroughEngine;
export interface PlaywrightPageLike {
  url(): string;
  evaluate<R, Arg>(pageFunction: (arg: Arg) => R | Promise<R>, arg: Arg): Promise<R>;
  goto(url: string, options?: { readonly waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit" }): Promise<unknown>;
  goBack(options?: { readonly waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit" }): Promise<unknown>;
  waitForTimeout?(timeout: number): Promise<void>;
  waitForLoadState?(
    state?: "load" | "domcontentloaded" | "networkidle",
    options?: { readonly timeout?: number },
  ): Promise<void>;
  once?(event: "download", listener: () => void): unknown;
  off?(event: "download", listener: () => void): unknown;
}

export function createPlaywrightWalkthroughTransport(
  page: PlaywrightPageLike,
  options?: {
    readonly allowedOrigins?: readonly string[];
    readonly allowSameSiteSubdomains?: boolean;
    readonly allowNewTabFollow?: boolean;
    readonly maxConsequence?: "observe" | "navigate" | "stage";
    readonly useTaskPolicy?: boolean;
    readonly settleMs?: number;
    readonly networkIdleTimeoutMs?: number;
  },
): BrowserTransport;
