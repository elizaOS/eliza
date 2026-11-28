export type ActionConsequence = "observe" | "navigate" | "stage" | "commit";

export interface ConsequenceClassification {
  readonly consequence: ActionConsequence;
  readonly reasons: readonly string[];
  readonly requiresGrant: boolean;
}

export interface ConsequenceTargetDescriptor {
  readonly action?: "click" | "fill" | "select" | "scroll" | "follow";
  readonly tag?: string | null;
  readonly type?: string | null;
  readonly role?: string | null;
  readonly label?: string | null;
  readonly inferredLabel?: string | null;
  readonly visibleText?: string | null;
  readonly submits?: boolean;
  readonly sensitive?: string | null;
  readonly inDialog?: boolean;
  readonly inFormWithPayment?: boolean;
  readonly inFormWithPassword?: boolean;
  readonly inert?: boolean;
  readonly hasHref?: boolean;
  readonly discloses?: boolean;
  readonly contentEditable?: boolean;
  readonly scrollOnly?: boolean;
}

export interface ConsequenceContext {
  readonly hasPaymentCredentialField?: boolean;
  readonly commitPattern?: RegExp | string | null;
}

export interface BlockerDismissalPlan {
  readonly blocker: Record<string, unknown>;
  readonly blockerIndex: number;
  readonly element: Record<string, unknown>;
  readonly command: {
    readonly subaction: "click";
    readonly snapshotId?: string;
    readonly nodeId?: string;
    readonly selector?: string;
    readonly expectedSelector?: string;
  };
}

export const COMMIT_CONTROL: RegExp;
export const ACTION_CONSEQUENCE_ORDER: readonly ActionConsequence[];
export function pageCommand(command: unknown, snapshotId?: unknown, validateOnly?: boolean, host?: unknown): unknown;
export function blockerSelectors(blockers: unknown, prefix: string): unknown[];
export function classifyActionConsequence(target?: ConsequenceTargetDescriptor, context?: ConsequenceContext): ConsequenceClassification;
export function dismissBlockerCommand(snapshot: unknown, options?: { readonly frameId?: number; readonly preferReject?: boolean }): BlockerDismissalPlan | null;
