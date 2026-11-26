// spec/os/android/noticeRoutes.md, "Story: Keep my notices to the account I am signed in to"; spec/os/android/notificationMirror.md, "Story: Mirror only the notifications I allowed"; spec/os/android/notificationMirror.md, "Story: Act on exactly the notice I see"
import type { PluginListenerHandle } from "@capacitor/core";
import type { ApprovalPhase } from "../../../gen/core__approvals.ts";
import { approvalNoticeBinding, approvalNoticeId, type NoticeRoute, type PendingTap, type WorkflowNoticeRoute as RouteModel } from "../../../gen/os__android__noticeRoutes.ts";
import type { Account, DeviceCredential } from "../../../gen/os__signIn__credential.ts";

export const LOCAL_AGENT_ORIGIN = "agent:local";
export const PENDING_WORKFLOW_TAP_EVENT = "pendingWorkflowTap";

export interface NoticeOwnerIdentity {
  origin: string;
  ownerId: string;
  agentId: string;
}

export interface WorkflowNoticeRoute extends NoticeOwnerIdentity {
  scope: string;
  workflowId: string;
  runId: string;
  versionId: string;
}

export interface NoticeTapNotice {
  id: string;
  revision: string;
  source: string;
  appLabel: string;
  title: string;
  text: string;
}

export interface PendingNoticeTap extends NoticeOwnerIdentity {
  scope: string;
  token: string;
  operationId: string;
  bindingHash: string;
  retained: boolean;
  question?: boolean;
  notice?: NoticeTapNotice;
  [identifier: string]: unknown;
}

export interface NoticeTapBinding extends NoticeOwnerIdentity {
  scope: string;
  current(): boolean;
}

export type NoticeTapResolution<Target> =
  | { kind: "lookup-unavailable" }
  | { kind: "none" }
  | { kind: "other-account" }
  | { kind: "unavailable" }
  | { kind: "ready"; token: string; target: Target; question: boolean; notice?: NoticeTapNotice };

export interface SuspendedApprovalNotice {
  id: string;
  bindingHash: string;
  expiresAt: number;
  route: WorkflowNoticeRoute;
}

export interface ApprovalNoticeIdentity {
  id: string;
  bindingHash: string;
}

export interface WorkflowApprovalNoticeReads<Run, Review> {
  detail(workflowId: string, signal: AbortSignal): Promise<{ versionId: string; removed?: boolean }>;
  receipt(runId: string, workflowId: string, signal: AbortSignal): Promise<Run & { versionId: string; finished: boolean }>;
  phoneReview(run: Run, signal: AbortSignal): Promise<Review & { finished: boolean; cancellationRequestedAt: string | null }>;
  approvals(review: Review, signal: AbortSignal): Promise<ReadonlyArray<{ id: string; expiresAt: number; phase: ApprovalPhase }>>;
}

export type ApprovalNoticeDecision = "resume" | "withdraw" | "stale";

export interface NoticeFenceOperations<T> {
  transition(account: Account): Promise<T>;
  enqueue(work: () => Promise<void>): void;
  available(account: Account): boolean;
  restore(result: T, account: Account, valid: () => boolean): Promise<void>;
}

export interface NoticeFenceUpdater {
  /** @throws {never} */
  update(credential: DeviceCredential, credentialRead: boolean): void;
}

export type WorkflowNoticeStatus = "posted" | "applying" | "failed" | "unknown" | "succeeded" | "withdrawn" | "expired" | "owner-changed" | "not-suspended" | "suspended";

export interface NoticeOwnerFenceReply {
  withdrawn: number;
  suspended: SuspendedApprovalNotice[];
}

export interface DeliveryChannel {
  id: string;
  name: string;
  importance: number;
  blocked: boolean;
  groupBlocked: boolean;
}

export interface DeliveryStatus {
  appEnabled: boolean;
  permissionGranted: boolean;
  interruption: "all" | "priority" | "alarms" | "none" | "unknown";
  channels: DeliveryChannel[];
  scope: string;
}

export interface MirrorApp {
  packageName: string;
  label: string;
  preview: boolean;
  available: boolean;
}

export interface MirrorStatus {
  revision: string;
  enabled: boolean;
  accessGranted: boolean;
  connected: boolean;
  paused: boolean;
  history: boolean;
  historyUnavailable: boolean;
  apps: MirrorApp[];
}

export interface MirrorChoice {
  packageName: string;
  label: string;
}

export interface MirrorPolicyChange {
  expectedRevision: string;
  enabled?: boolean;
  history?: boolean;
  apps?: Array<{ packageName: string; preview: boolean }>;
}

export interface MirrorHistoryRow {
  id: string;
  appLabel: string;
  at: number;
  state: string;
}

export type NoticeSourceKind = "own" | "external";

export interface NoticeRow {
  id: string;
  revision: string;
  source: NoticeSourceKind;
  kind?: string;
  appLabel: string;
  title: string;
  text: string;
  at: number;
  clearable: boolean;
  canOpen: boolean;
  redacted?: boolean;
}

export interface NoticeRowRef {
  id: string;
  revision: string;
  source: NoticeSourceKind;
}

export interface NotificationsNativePlugin {
  workflowPresentationCapabilities(): Promise<unknown>;
  pendingWorkflowTap(): Promise<unknown>;
  consumeWorkflowTap(input: { token: string; unavailable?: boolean; discard?: boolean; noticeRevision?: string }): Promise<unknown>;
  postWorkflow(input: { operationId: string; bindingHash: string; route: WorkflowNoticeRoute; title: string; body: string }): Promise<unknown>;
  workflowReceipt(input: { operationId: string; bindingHash: string; title: string; body: string }): Promise<unknown>;
  noticeOwner(input: { owner: NoticeOwnerIdentity | null }): Promise<unknown>;
  postWorkflowApproval(input: { id: string; bindingHash: string; route: WorkflowNoticeRoute; expiresAt: number }): Promise<unknown>;
  resumeWorkflowApproval(input: { id: string; bindingHash: string; route: WorkflowNoticeRoute; expiresAt: number }): Promise<unknown>;
  withdrawWorkflowApproval(input: { id: string }): Promise<unknown>;
  status(): Promise<unknown>;
  openChannelSettings(input: { id: string }): Promise<unknown>;
  crossAppStatus(): Promise<unknown>;
  notificationApps(): Promise<unknown>;
  setNotificationPolicy(input: MirrorPolicyChange): Promise<unknown>;
  resumeCrossApp(input: { expectedRevision: string }): Promise<unknown>;
  openNotificationAccess(): Promise<unknown>;
  notificationHistory(): Promise<unknown>;
  clearNotificationHistory(input: { expectedRevision: string }): Promise<unknown>;
  list(): Promise<unknown>;
  open(input: NoticeRowRef): Promise<unknown>;
  dismiss(input: NoticeRowRef): Promise<unknown>;
  clear(input: { items: NoticeRowRef[] }): Promise<unknown>;
  addListener(event: typeof PENDING_WORKFLOW_TAP_EVENT, listener: () => void): Promise<PluginListenerHandle>;
}

export interface NoticesClientOptions {
  name?: string;
  plugin?: NotificationsNativePlugin;
}

export interface NoticesClient {
  presentsWorkflow(): Promise<boolean>;
  pendingTap(): Promise<Partial<PendingNoticeTap>>;
  consumeTap(input: { token: string; unavailable?: boolean; discard?: boolean; noticeRevision?: string }): Promise<void>;
  postWorkflow(input: { operationId: string; bindingHash: string; route: WorkflowNoticeRoute; title: string; body: string }): Promise<WorkflowNoticeStatus>;
  workflowReceipt(input: { operationId: string; bindingHash: string; title: string; body: string }): Promise<WorkflowNoticeStatus>;
  publishOwner(owner: NoticeOwnerIdentity | null): Promise<NoticeOwnerFenceReply>;
  postApproval(input: { route: WorkflowNoticeRoute; proposalId: string; expiresAt: number; phase: ApprovalPhase }): Promise<WorkflowNoticeStatus | "not-pending">;
  resumeApproval(notice: SuspendedApprovalNotice): Promise<WorkflowNoticeStatus>;
  withdrawApproval(id: string): Promise<void>;
  delivery(): Promise<DeliveryStatus>;
  openChannelSettings(id: string): Promise<void>;
  mirrorStatus(): Promise<MirrorStatus>;
  mirrorChoices(): Promise<MirrorChoice[]>;
  setMirrorPolicy(change: MirrorPolicyChange): Promise<MirrorStatus>;
  resumeMirror(expectedRevision: string): Promise<MirrorStatus>;
  openNotificationAccess(): Promise<void>;
  mirrorHistory(): Promise<MirrorHistoryRow[]>;
  clearMirrorHistory(expectedRevision: string): Promise<void>;
  list(): Promise<{ items: NoticeRow[]; scope: string }>;
  open(row: NoticeRowRef): Promise<void>;
  dismiss(row: NoticeRowRef): Promise<void>;
  clear(rows: NoticeRowRef[]): Promise<Array<{ id: string; status: "requested" | "unavailable" }>>;
  onPendingTap(listener: () => void): Promise<PluginListenerHandle>;
}

/** @throws {never} */
export function noticeOwnerOf(account: Account, agentId: string): NoticeOwnerIdentity | null {
  return account.userId === "" ? null : { origin: LOCAL_AGENT_ORIGIN, ownerId: `${account.organizationId}:${account.userId}`, agentId };
}

/** @throws {never} */
export function routeModelOf(route: WorkflowNoticeRoute): RouteModel {
  return {
    noticeScope: route.scope,
    noticeOrigin: route.origin,
    noticeOwner: route.ownerId,
    noticeAgent: route.agentId,
    workflowId: route.workflowId,
    runId: route.runId,
    versionId: route.versionId,
  };
}

/** @throws {never} */
export function noticeRouteOf(value: { scope?: unknown; origin?: unknown; ownerId?: unknown; agentId?: unknown }): NoticeRoute {
  const text = (field: unknown) => (typeof field === "string" ? field : "");
  return { routeScope: text(value.scope), routeOrigin: text(value.origin), routeOwner: text(value.ownerId), routeAgent: text(value.agentId) };
}

/** @throws {never} */
export function approvalNoticeTexts(route: WorkflowNoticeRoute, proposalId: string): { id: string; binding: string } {
  const model = routeModelOf(route);
  const id = approvalNoticeId(model, proposalId);
  const bound = approvalNoticeBinding(model, proposalId);
  const r = bound.bindingRoute;
  return {
    id: JSON.stringify(["workflow-approval-notice", id.idScope, id.idRun, id.idProposal]),
    binding: JSON.stringify(["workflow-approval-route", r.noticeScope, r.noticeOrigin, r.noticeOwner, r.noticeAgent, r.workflowId, r.runId, r.versionId, bound.bindingProposal]),
  };
}

/** @throws {never} */
export function validProposalId(proposalId: string): boolean {
  return proposalId.length > 0 && proposalId.length <= 256;
}

/** @throws {never} */
export function tapSignature(tap: Partial<PendingNoticeTap>, identifiers: readonly string[]): string {
  const fields = ["token", "operationId", "bindingHash", ...identifiers].map((key) => tap[key] ?? null);
  return JSON.stringify([fields, tap.question ?? null, tap.notice ?? null]);
}

/** @throws {never} */
export function identifiersPresent(tap: Partial<PendingNoticeTap>, identifiers: readonly string[]): boolean {
  return identifiers.every((key) => typeof tap[key] === "string");
}

/** @throws {never} */
export function pendingTapModel(tap: Partial<PendingNoticeTap>, identifiers: readonly string[], revision: number): PendingTap {
  return { token: tap.token ?? "", route: noticeRouteOf(tap), retained: tap.retained === true, identifiersPresent: identifiersPresent(tap, identifiers), tapRevision: revision };
}

/** @throws {never} */
export function tapCheckpoint(signal: AbortSignal, binding: NoticeTapBinding): () => void {
  return () => {
    signal.throwIfAborted();
    if (!binding.current()) throw new Error("Agent changed");
  };
}

/** @throws {never} */
export function bindingLive(binding: NoticeTapBinding | null): boolean {
  try {
    return binding?.current() === true;
  } catch {
    return false;
  }
}
