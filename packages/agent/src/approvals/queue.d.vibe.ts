import { Effect, Schema } from "effect";
import { Service, type IAgentRuntime } from "@elizaos/core";
import { type PageQuery, type Refusal } from "../../gen/agent__approvals.effect.vibe";
export declare const ownerApprovalsServiceType = "owner_approvals";
export declare const calendarApprovalExecutorServiceType = "calendar_approval_executor";
export type ApprovalState = "pending" | "approved" | "retryable" | "reconciliation_required" | "done" | "rejected" | "expired";
export type ApprovalDecision = "approve" | "reject";
export type ResolvedKind = "succeeded" | "rejected" | "invalidated" | "retryable" | "blocked";
export declare const approvalStates: {
    readonly Pending: "pending";
    readonly Approved: "approved";
    readonly Retryable: "retryable";
    readonly ReconciliationRequired: "reconciliation_required";
    readonly Done: "done";
    readonly Declined: "rejected";
    readonly Expired: "expired";
};
declare const NewApproval: Schema.Struct<{
    id: Schema.String;
    subjectUserId: Schema.String;
    requestedBy: Schema.String;
    action: Schema.String;
    payload: Schema.$Record<Schema.String, Schema.Unknown>;
    reason: Schema.String;
    expiresAt: Schema.String;
}>;
declare const Details: Schema.Struct<{
    readonly id: Schema.String;
    readonly subjectUserId: Schema.String;
    readonly requestedBy: Schema.String;
    readonly action: Schema.String;
    readonly payload: Schema.$Record<Schema.String, Schema.Unknown>;
    readonly reason: Schema.String;
    readonly expiresAt: Schema.String;
    readonly createdAt: Schema.String;
    readonly updatedAt: Schema.String;
}>;
declare const ResolveFailure: Schema.Struct<{
    readonly code: Schema.String;
    readonly retryable: Schema.Boolean;
    readonly acceptance: Schema.Literals<readonly ["not_accepted", "unknown"]>;
}>;
declare const LedgerOutcome: Schema.Struct<{
    readonly result: Schema.Literals<readonly ["ChangeSucceeded", "ChangeInvalidated", "ChangeRetryable", "ChangeUnconfirmed"]>;
    readonly text: Schema.String;
    readonly failure: Schema.optionalKey<Schema.Struct<{
        readonly code: Schema.String;
        readonly retryable: Schema.Boolean;
        readonly acceptance: Schema.Literals<readonly ["not_accepted", "unknown"]>;
    }>>;
}>;
export type NewApproval = typeof NewApproval.Type;
type Details = typeof Details.Type;
export type ResolveFailure = typeof ResolveFailure.Type;
export type LedgerOutcome = typeof LedgerOutcome.Type;
export type ApprovalRecord = Details & {
    readonly state: ApprovalState;
    readonly revision: string;
};
export interface CalendarApprovalExecutor {
    /** @throws {never} */
    execute(request: ApprovalRecord): Promise<LedgerOutcome>;
}
export interface ResolveReply {
    readonly requestId: string;
    readonly decision: ApprovalDecision;
    readonly kind: ResolvedKind;
    readonly text: string;
    readonly failure?: ResolveFailure;
}
export type ApprovalResolution = {
    readonly kind: "resolved";
    readonly reply: ResolveReply;
} | {
    readonly kind: "refused";
    readonly requestId: string;
    readonly refusal: Refusal;
};
declare const ApprovalsUnavailable_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "ApprovalsUnavailable";
} & Readonly<A>;
export declare class ApprovalsUnavailable extends ApprovalsUnavailable_base<{
    readonly reason: string;
    readonly cause?: unknown;
}> {
}
declare const RequestRefused_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "RequestRefused";
} & Readonly<A>;
export declare class RequestRefused extends RequestRefused_base<{
    readonly id: string;
    readonly reason: "invalid" | "duplicate";
}> {
}
declare const PageRefused_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "PageRefused";
} & Readonly<A>;
export declare class PageRefused extends PageRefused_base<{
    readonly limit: number;
}> {
}
export interface ApprovalsHost {
    /** @throws {never} */
    getCache<T>(key: string): Promise<T | undefined>;
    /** @throws {never} */
    setCache<T>(key: string, value: T): Promise<boolean>;
    /** @throws {never} */
    executor(): CalendarApprovalExecutor | undefined;
    readonly logger: Pick<IAgentRuntime["logger"], "error">;
    readonly now: Effect.Effect<number>;
}
export interface ApprovalQueue {
    request(row: NewApproval): Effect.Effect<ApprovalRecord, ApprovalsUnavailable | RequestRefused>;
    list(query: PageQuery): Effect.Effect<ApprovalRecord[], ApprovalsUnavailable | PageRefused>;
    resolve(id: string, decision: ApprovalDecision, revision: string): Effect.Effect<ApprovalResolution, ApprovalsUnavailable>;
    lapseIfDue(id: string): Effect.Effect<boolean, ApprovalsUnavailable>;
}
export interface OwnerApprovals {
    /** @throws {never} */
    request(row: NewApproval): Promise<ApprovalRecord>;
    /** @throws {never} */
    list(query: PageQuery): Promise<ApprovalRecord[]>;
    /** @throws {never} */
    resolve(id: string, decision: ApprovalDecision, revision: string): Promise<ApprovalResolution>;
}
/** @throws {never} */
export declare function approvalQueue(host: ApprovalsHost): ApprovalQueue;
/** @throws {never} */
export declare function runtimeApprovalsHost(runtime: IAgentRuntime): ApprovalsHost;
export declare class OwnerApprovalsService extends Service implements OwnerApprovals {
    static serviceType: string;
    capabilityDescription: string;
    readonly queue: ApprovalQueue;
    /** @throws {never} */
    static start(runtime: IAgentRuntime): Promise<Service>;
    /** @throws {never} */
    request(row: NewApproval): Promise<ApprovalRecord>;
    /** @throws {never} */
    list(query: PageQuery): Promise<ApprovalRecord[]>;
    /** @throws {never} */
    resolve(id: string, decision: ApprovalDecision, revision: string): Promise<ApprovalResolution>;
    /** @throws {never} */
    stop(): Promise<void>;
}
export {};
