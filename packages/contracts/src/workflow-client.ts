/**
 * Receipt-checked client for the workflow agent routes (`plugin-workflow`
 * `routes/workflow-routes.ts`), shared by phone and desktop renderers.
 *
 * Transport-agnostic and browser-safe: the host supplies one `request`
 * function (owner session, local agent or an explicit linked agent) and this
 * client never chooses a route on its own. Every mutation carries the exact
 * reviewed version and a fresh mutation or submission identity, and every
 * response is accepted only when its identity matches what was sent. A failure
 * other than the agent's own refusal of that identity leaves the outcome
 * unknown; callers reconcile by identity before offering anything again, and a
 * submission identity is admitted by the agent at most once, so a resend can
 * never start a second run.
 */
import {
  assertPhoneWorkflowCapabilities,
  type PhoneDeviceTarget,
  type PhoneWorkflowCatalog,
  type PhoneWorkflowSaveReceipt,
  type PhoneWorkflowSpec,
  parsePhoneScheduledOccurrence,
  parsePhoneWorkflowCatalog,
  parsePhoneWorkflowSaveReceipt,
  phoneWorkflowBytes,
  validatePhoneWorkflowSpec,
} from "./phone-workflow.ts";

/** Metadata key holding a typed phone workflow's reviewed specification. */
export const WORKFLOW_PHONE_SPEC_METADATA_KEY = "elizaPhoneWorkflowSpec";
/** Metadata key marking an agent-owned digest workflow. */
export const WORKFLOW_HOSTED_DIGEST_METADATA_KEY = "elizaHostedDigestV1";
/** Largest generation response accepted before parsing a generated draft. */
export const WORKFLOW_GENERATION_RESPONSE_MAX_BYTES = 75_000;

export interface RemoteWorkflow {
  id: string;
  name: string;
  description: string;
  active: boolean;
  removed?: boolean;
  triggerCleanup?: "pending" | "complete";
  versionId: string;
  steps: Array<{ label: string; description?: string }>;
  /** The stored typed specification, unvalidated; absent when unreadable. */
  phoneSpec?: unknown;
  hostedDigest?: boolean;
}
/** Host-process reconciliation (`WorkflowExecution.reconciliation`). It never replaces the canonical receipt. */
export type WorkflowRunReconciliation = {
  state: "worker-running" | "outcome-unknown";
  message: string;
};
/** A run admitted by a typed local-time schedule. `missed` and `overlap` record an occurrence that did not run. */
export interface WorkflowRunOccurrence {
  scheduledAt: string;
  status: "ready" | "missed" | "overlap";
}
export interface WorkflowRun {
  id: string;
  workflowId: string;
  status: string;
  startedAt: string;
  finished: boolean;
  versionId: string;
  stoppedAt?: string;
  error?: string;
  output?: string;
  reconciliation?: WorkflowRunReconciliation;
  occurrence?: WorkflowRunOccurrence;
  events: Array<{ type: string; at: string; node?: string }>;
}
export interface WorkflowApproval {
  runId: string;
  workflowId: string;
  workflowVersionId: string;
  nodeId: string;
  iteration: number;
  requestDigest: string;
  status: "pending" | "approved" | "denied";
  title: string;
  summary: string;
  operation: string;
  target: string;
  account: string;
  supported: boolean;
  decidedBy?: string;
}
export interface WorkflowApprovalReceipt {
  runId: string;
  workflowId: string;
  workflowVersionId: string;
  finished: boolean;
  cancellationRequested: boolean;
  approvals: WorkflowApproval[];
}
export interface WorkflowMetadataReceipt {
  mutationId: string;
  workflowId: string;
  previousVersionId: string;
  versionId: string;
  name: string;
  description: string;
  active: boolean;
  appliedAt: string;
}
export interface WorkflowLifecycleReceipt {
  mutationId: string;
  workflowId: string;
  previousVersionId: string;
  versionId: string;
  operation: "remove" | "restore";
  appliedAt: string;
}
export interface PhoneWorkflowSaveExpectation {
  mutationId: string;
  specDigest: string;
  compilerRevision: string;
  workflowId?: string;
  versionId?: string;
}
export type WorkflowRequest = (
  path: string,
  body: unknown | undefined,
  signal: AbortSignal,
) => Promise<unknown>;
export interface WorkflowClientOptions {
  /**
   * Normalizes a typed specification. Defaults to the shared
   * `validatePhoneWorkflowSpec`; a host may wrap it (for example to keep
   * development enrollment labels) but must not broaden what it accepts.
   */
  normalizePhoneSpec?: (value: unknown) => PhoneWorkflowSpec;
}

/** Only bounded public refusal identity crosses the transport boundary. */
export class WorkflowHttpError extends Error {
  readonly clarification?: string;
  readonly code?: string;
  readonly workflowId?: string;
  readonly submissionId?: string;
  readonly mutationId?: string;
  readonly expectedVersionId?: string;
  readonly status: number;
  constructor(status: number, body: unknown) {
    super(
      "Workflow request unavailable. Check execution history before repeating a run.",
    );
    this.status = status;
    if (!body || typeof body !== "object" || Array.isArray(body)) return;
    const data = body as Record<string, unknown>;
    if (
      status === 422 &&
      typeof data.error === "string" &&
      data.error.startsWith("Workflow needs clarification: ") &&
      data.error.length <= 1100 &&
      !data.error.includes("\0")
    )
      this.clarification = data.error;
    const self = this as {
      -readonly [K in
        | "code"
        | "workflowId"
        | "submissionId"
        | "mutationId"
        | "expectedVersionId"]?: string;
    };
    for (const key of [
      "code",
      "workflowId",
      "submissionId",
      "mutationId",
      "expectedVersionId",
    ] as const) {
      const value = data[key];
      if (typeof value === "string" && value.length > 0 && value.length <= 200)
        self[key] = value;
    }
  }
}
/** The agent refused this exact run submission because the version changed. Nothing ran. */
export class WorkflowAdmissionRejected extends Error {
  constructor() {
    super(
      "Workflow changed before acceptance. Refresh and review the current steps before a new run.",
    );
  }
}
/** The agent refused this exact typed save because the workflow changed first. Nothing was saved. */
export class WorkflowTypedRejected extends Error {
  constructor() {
    super(
      "This workflow changed on the agent before your edit was saved. Nothing was saved.",
    );
  }
}
export class WorkflowMetadataRejected extends Error {
  constructor() {
    super(
      "Workflow changed before saving. Reopen Change and review the current name and description.",
    );
  }
}
export class WorkflowLifecycleRejected extends Error {
  constructor() {
    super(
      "Removal or restore was not applied. Refresh the workflow and review its version, cleanup and any ongoing executions.",
    );
  }
}
/** The agent refused to turn on this schedule because the workflow changed after review. Nothing was enabled. */
export class WorkflowActivationRejected extends Error {
  constructor() {
    super(
      "This workflow changed before its schedule was turned on. Nothing was enabled. Review the current version first.",
    );
  }
}

type Bag = Record<string, unknown>;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const obj = (value: unknown): Bag => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid workflow response");
  return value as Bag;
};
const str = (value: unknown): string => {
  if (typeof value !== "string" || !value)
    throw new Error("Invalid workflow field");
  return value;
};
const refused = (
  error: unknown,
  code: string,
  identity: Partial<
    Pick<
      WorkflowHttpError,
      "workflowId" | "submissionId" | "mutationId" | "expectedVersionId"
    >
  >,
) =>
  error instanceof WorkflowHttpError &&
  error.status === 409 &&
  error.code === code &&
  Object.entries(identity).every(
    ([key, value]) => error[key as keyof typeof identity] === value,
  );

/** SHA-256 hex of the canonical JSON bytes; the agent digests a typed specification the same way. */
export async function workflowSpecDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * A scheduled occurrence that the agent settled without running anything
 * (`{status: "missed" | "overlap", scheduledAt, text}` as the execution output).
 * `missed` is an occurrence that came due while the agent was not running
 * (powered-on scheduling records it once and never replays it); `overlap` is one
 * skipped because an earlier run of the same workflow was still active.
 */
export interface WorkflowOccurrenceNotRun {
  status: "missed" | "overlap";
  scheduledAt: string;
  text: string;
}

/** Reads a raw execution output as an occurrence that did not run, or undefined for any other output. */
export function workflowOccurrenceNotRun(
  value: unknown,
): WorkflowOccurrenceNotRun | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const p = value as Bag;
  return (p.status === "missed" || p.status === "overlap") &&
    typeof p.text === "string" &&
    typeof p.scheduledAt === "string" &&
    Number.isFinite(Date.parse(p.scheduledAt))
    ? {
        status: p.status,
        scheduledAt: p.scheduledAt,
        text: p.text.slice(0, 1000),
      }
    : undefined;
}
function runOccurrence(
  input: unknown,
  output: unknown,
): WorkflowRunOccurrence | undefined {
  const record =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Bag).typedSchedule
      : undefined;
  const settled = workflowOccurrenceNotRun(output);
  // A generic schedule's occurrence carries no typed admission: its settlement alone records it.
  if (record === undefined)
    return settled
      ? { scheduledAt: settled.scheduledAt, status: settled.status }
      : undefined;
  const admitted = parsePhoneScheduledOccurrence(record);
  if (!admitted) return undefined;
  return {
    scheduledAt: admitted.scheduledAt,
    status: settled?.status ?? admitted.status,
  };
}
function reconciliation(value: unknown): WorkflowRunReconciliation | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid execution reconciliation");
  const r = value as Bag;
  if (
    (r.state !== "worker-running" && r.state !== "outcome-unknown") ||
    typeof r.message !== "string"
  )
    throw new Error("Invalid execution reconciliation");
  return { state: r.state, message: r.message.slice(0, 2000) };
}
/** Present the typed worker's final text; intermediate step inputs remain in the agent receipt. */
function workflowOutput(value: unknown, runId: string): string {
  if (typeof value === "string") return value.slice(0, 4000);
  const settled = workflowOccurrenceNotRun(value);
  if (settled) return settled.text;
  if (Array.isArray(value) && value.length === 1) {
    const item = value[0];
    if (
      item &&
      typeof item === "object" &&
      item.nodeId === "typed-steps" &&
      item.runId === runId &&
      typeof item.text === "string"
    )
      return item.text.slice(0, 4000);
  }
  return (JSON.stringify(value) ?? "").slice(0, 4000);
}
/**
 * A stored typed specification that is not a JSON object is treated as absent:
 * one unreadable migrated definition stays listed as an untyped workflow
 * (steps, history and removal remain available) instead of failing the list.
 */
function storedPhoneSpec(value: unknown): { phoneSpec?: unknown } {
  if (typeof value !== "string" || value.length > 65536) return {};
  try {
    const spec: unknown = JSON.parse(value);
    return spec && typeof spec === "object" && !Array.isArray(spec)
      ? { phoneSpec: spec }
      : {};
  } catch {
    return {};
  }
}
/** Parses one workflow definition from the agent. */
export function parseRemoteWorkflow(value: unknown): RemoteWorkflow {
  const p = obj(value);
  const removed = p.removed;
  if (
    typeof p.active !== "boolean" ||
    (removed !== undefined && typeof removed !== "boolean") ||
    (removed === true &&
      !["pending", "complete"].includes(String(p.triggerCleanup))) ||
    !Array.isArray(p.steps ?? [])
  )
    throw new Error("Invalid workflow");
  const metadata =
    p.metadata && typeof p.metadata === "object" && !Array.isArray(p.metadata)
      ? (p.metadata as Bag)
      : {};
  return {
    id: str(p.id),
    name: str(p.name),
    description: typeof p.description === "string" ? p.description : "",
    active: p.active,
    removed: removed === true,
    triggerCleanup: p.triggerCleanup === "pending" ? "pending" : "complete",
    versionId: str(p.versionId),
    ...storedPhoneSpec(metadata[WORKFLOW_PHONE_SPEC_METADATA_KEY]),
    ...(typeof metadata[WORKFLOW_HOSTED_DIGEST_METADATA_KEY] === "string"
      ? { hostedDigest: true }
      : {}),
    steps: ((p.steps ?? []) as unknown[]).map((x) => {
      const step = obj(x);
      return {
        label: str(step.label),
        ...(typeof step.description === "string"
          ? { description: step.description }
          : {}),
      };
    }),
  };
}
/** Parses one execution receipt, binding every event to its run and workflow. */
export function parseWorkflowRun(value: unknown): WorkflowRun {
  const p = obj(value);
  if (typeof p.finished !== "boolean") throw new Error("Invalid execution");
  const id = str(p.id);
  const workflowId = str(p.workflowId);
  const events = p.events ?? [];
  if (!Array.isArray(events)) throw new Error("Invalid execution events");
  const error = p.error as Bag | undefined;
  const settled = reconciliation(p.reconciliation);
  const occurrence = runOccurrence(p.input, p.output);
  return {
    id,
    workflowId,
    status: str(p.status),
    startedAt: str(p.startedAt),
    finished: p.finished,
    versionId: str(p.workflowVersionId),
    ...(typeof p.stoppedAt === "string" ? { stoppedAt: p.stoppedAt } : {}),
    ...(typeof error?.message === "string"
      ? { error: error.message.slice(0, 2000) }
      : {}),
    ...(p.output === undefined ? {} : { output: workflowOutput(p.output, id) }),
    ...(settled ? { reconciliation: settled } : {}),
    ...(occurrence ? { occurrence } : {}),
    events: events.slice(-100).map((event: unknown) => {
      const e = obj(event);
      if (e.runId !== id || e.workflowId !== workflowId)
        throw new Error("Execution event identity mismatch");
      return {
        type: str(e.type).slice(0, 120),
        at: str(e.timestamp),
        ...(typeof e.nodeId === "string"
          ? { node: e.nodeId.slice(0, 200) }
          : {}),
      };
    }),
  };
}
/** Accepts an approval receipt only for this exact run, workflow and version. */
export function parseWorkflowApprovalReceipt(
  value: unknown,
  run: Pick<WorkflowRun, "id" | "workflowId" | "versionId">,
): WorkflowApprovalReceipt {
  const p = obj(value);
  if (
    p.runId !== run.id ||
    p.workflowId !== run.workflowId ||
    p.workflowVersionId !== run.versionId ||
    typeof p.finished !== "boolean" ||
    typeof p.cancellationRequested !== "boolean" ||
    !Array.isArray(p.approvals) ||
    p.approvals.length > 100
  )
    throw new Error("Approval receipt identity mismatch");
  const approvals = p.approvals.map((item: unknown) => {
    const a = obj(item);
    if (
      a.runId !== run.id ||
      a.workflowId !== run.workflowId ||
      a.workflowVersionId !== run.versionId ||
      !Number.isSafeInteger(a.iteration) ||
      (a.iteration as number) < 0 ||
      !["pending", "approved", "denied"].includes(String(a.status)) ||
      typeof a.supported !== "boolean" ||
      typeof a.requestDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(a.requestDigest)
    )
      throw new Error("Approval identity mismatch");
    for (const [key, max] of Object.entries({
      nodeId: 200,
      title: 500,
      summary: 4000,
      operation: 500,
      target: 1000,
      account: 500,
    })) {
      const field = a[key];
      if (typeof field !== "string" || field.length > max)
        throw new Error("Unsupported approval field");
    }
    if (!a.nodeId) throw new Error("Missing approval node");
    return {
      ...a,
      supported:
        a.supported &&
        (["title", "summary", "operation", "target", "account"] as const).every(
          (key) => (a[key] as string).trim().length > 0,
        ),
    } as WorkflowApproval;
  });
  return {
    runId: run.id,
    workflowId: run.workflowId,
    workflowVersionId: run.versionId,
    finished: p.finished,
    cancellationRequested: p.cancellationRequested,
    approvals,
  };
}

/** Receipt-checked workflow operations over one host-chosen transport. */
export class WorkflowClient {
  protected readonly request: WorkflowRequest;
  protected readonly normalizeSpec: (value: unknown) => PhoneWorkflowSpec;
  constructor(request: WorkflowRequest, options: WorkflowClientOptions = {}) {
    this.request = request;
    this.normalizeSpec =
      options.normalizePhoneSpec ?? validatePhoneWorkflowSpec;
  }

  private async status(signal: AbortSignal): Promise<Bag> {
    return obj(await this.request("/api/workflow/status", undefined, signal));
  }
  private async ready(signal: AbortSignal): Promise<Bag> {
    const status = await this.status(signal);
    if (status.engine !== "smthrs" || status.status !== "ready")
      throw new Error("Workflow capability unavailable");
    return status;
  }
  async supportsSubmissionReconciliation(signal: AbortSignal) {
    return (await this.ready(signal)).manualSubmissionProtocol === 1;
  }
  async metadataSupported(signal: AbortSignal) {
    const p = await this.status(signal);
    return (
      p.engine === "smthrs" &&
      p.status === "ready" &&
      p.metadataMutationProtocol === 1
    );
  }
  async lifecycleSupported(signal: AbortSignal) {
    const p = await this.status(signal);
    return (
      p.engine === "smthrs" &&
      p.status === "ready" &&
      p.lifecycleMutationProtocol === 1
    );
  }
  /** Typed local-time schedules: armed per reviewed version, admitted at exact occurrences while the agent runs. */
  async typedSchedulesSupported(signal: AbortSignal) {
    const p = await this.status(signal);
    return (
      p.engine === "smthrs" &&
      p.status === "ready" &&
      p.typedScheduleProtocol === 1
    );
  }

  // Typed phone workflows.
  async phoneCatalog(signal: AbortSignal): Promise<PhoneWorkflowCatalog> {
    return parsePhoneWorkflowCatalog(
      await this.request("/api/workflow/phone/catalog", undefined, signal),
    );
  }
  /**
   * Generates or revises a typed draft. The owner-set trigger, device target,
   * offered operations and every selected read scope must come back unchanged.
   */
  async generatePhone(
    prompt: string,
    catalog: PhoneWorkflowCatalog,
    operations: string[],
    signal: AbortSignal,
    existing?: PhoneWorkflowSpec,
    device?: PhoneDeviceTarget,
  ): Promise<PhoneWorkflowSpec> {
    if (catalog.generationProtocol !== 1)
      throw new Error("Typed generation is unavailable on this agent");
    if (!prompt.trim() || prompt.length > 4000 || prompt.includes("\0"))
      throw new Error("Describe the workflow in 1–4000 characters");
    if (existing) existing = this.normalizeSpec(existing);
    let response: unknown;
    try {
      response = await this.request(
        "/api/workflow/phone/generate",
        {
          prompt,
          operations,
          ...(existing ? { existing } : {}),
          ...(device ? { device } : {}),
          catalogRevision: catalog.catalogRevision,
          compilerRevision: catalog.compilerRevision,
        },
        signal,
      );
    } catch (error) {
      if (error instanceof WorkflowHttpError)
        throw new Error(
          error.status === 422
            ? (error.clarification ??
                "The request needs clarification. Select any Notes or Calendar scope first, and describe a manual workflow using the available steps.")
            : "The agent could not generate a valid draft. Your current draft is unchanged.",
        );
      throw error;
    }
    signal.throwIfAborted();
    if (phoneWorkflowBytes(response) > WORKFLOW_GENERATION_RESPONSE_MAX_BYTES)
      throw new Error("Generated draft exceeds the response limit");
    const spec = this.normalizeSpec(obj(response).spec);
    // The schedule is owner-set: a generated draft keeps the trigger the owner chose.
    if (
      JSON.stringify(spec.trigger) !==
      JSON.stringify(existing?.trigger ?? { kind: "manual" })
    )
      throw new Error("Generated draft changed when this workflow runs");
    assertPhoneWorkflowCapabilities(spec, catalog);
    if (
      JSON.stringify(spec.device) !==
        JSON.stringify(device ?? existing?.device) ||
      spec.steps.some((s) => !operations.includes(s.operation))
    )
      throw new Error(
        "Generated draft changed the available device or operations",
      );
    const scope = (s: PhoneWorkflowSpec["steps"][number]) =>
      JSON.stringify(
        s.operation === "selected_notes"
          ? (s as { notes: unknown }).notes
          : (s as { range?: unknown }).range,
      );
    for (const step of spec.steps) {
      if (
        step.operation !== "selected_notes" &&
        step.operation !== "calendar_range"
      )
        continue;
      if (
        !existing?.steps.some(
          (s) => s.operation === step.operation && scope(s) === scope(step),
        )
      )
        throw new Error("Generated draft changed a selected read scope");
    }
    return (await this.verifyPhoneValidation(response, spec, catalog)).spec;
  }
  /** Accepts a validation only for the exact reviewed bytes, digest, compiler and catalog, saved inactive. */
  async verifyPhoneValidation(
    value: unknown,
    spec: PhoneWorkflowSpec,
    catalog: PhoneWorkflowCatalog,
  ): Promise<{ spec: PhoneWorkflowSpec; specDigest: string }> {
    const p = obj(value);
    const canonical = this.normalizeSpec(p.spec);
    if (
      JSON.stringify(canonical) !== JSON.stringify(spec) ||
      p.specDigest !== (await workflowSpecDigest(spec)) ||
      p.compilerRevision !== catalog.compilerRevision ||
      p.catalogRevision !== catalog.catalogRevision ||
      p.active !== false
    )
      throw new Error("Agent validation changed the reviewed workflow");
    return { spec: canonical, specDigest: p.specDigest as string };
  }
  async validatePhone(
    spec: PhoneWorkflowSpec,
    catalog: PhoneWorkflowCatalog,
    signal: AbortSignal,
  ) {
    return this.verifyPhoneValidation(
      await this.request(
        "/api/workflow/phone/validate",
        {
          spec,
          catalogRevision: catalog.catalogRevision,
          compilerRevision: catalog.compilerRevision,
        },
        signal,
      ),
      spec,
      catalog,
    );
  }
  async savePhone(
    spec: PhoneWorkflowSpec,
    catalog: PhoneWorkflowCatalog,
    expected: PhoneWorkflowSaveExpectation,
    signal: AbortSignal,
  ): Promise<PhoneWorkflowSaveReceipt> {
    let response: Bag;
    try {
      response = obj(
        await this.request(
          expected.workflowId
            ? `/api/workflow/workflows/${encodeURIComponent(expected.workflowId)}/phone-spec`
            : "/api/workflow/phone/workflows",
          {
            spec,
            catalogRevision: catalog.catalogRevision,
            compilerRevision: catalog.compilerRevision,
            mutationId: expected.mutationId,
            ...(expected.workflowId
              ? { expectedVersionId: expected.versionId }
              : {}),
          },
          signal,
        ),
      );
    } catch (error) {
      // Only the agent's refusal of this exact edit is a known non-save. Any other failure leaves the outcome unknown.
      if (
        expected.workflowId &&
        refused(error, "WORKFLOW_TYPED_NOT_APPLIED", {
          workflowId: expected.workflowId,
          mutationId: expected.mutationId,
          expectedVersionId: expected.versionId,
        })
      )
        throw new WorkflowTypedRejected();
      throw error;
    }
    return parsePhoneWorkflowSaveReceipt(response.receipt, expected);
  }
  async phoneSaveReceipt(
    expected: PhoneWorkflowSaveExpectation,
    signal: AbortSignal,
  ): Promise<PhoneWorkflowSaveReceipt | null> {
    if (!UUID_V4.test(expected.mutationId))
      throw new Error("Invalid save identity");
    const result = obj(
      await this.request(
        `/api/workflow/phone/mutations/${expected.mutationId}`,
        undefined,
        signal,
      ),
    );
    if (result.mutationId !== expected.mutationId)
      throw new Error("Save identity changed");
    return result.receipt === null
      ? null
      : parsePhoneWorkflowSaveReceipt(result.receipt, expected);
  }

  // Approvals.
  async approvals(
    run: WorkflowRun,
    signal: AbortSignal,
  ): Promise<WorkflowApprovalReceipt | null> {
    if ((await this.status(signal)).approvalReceiptProtocol !== 1) return null;
    return parseWorkflowApprovalReceipt(
      await this.request(
        `/api/workflow/executions/${encodeURIComponent(run.id)}/approvals`,
        undefined,
        signal,
      ),
      run,
    );
  }
  async decideApproval(
    run: WorkflowRun,
    approval: WorkflowApproval,
    approved: boolean,
    signal: AbortSignal,
  ): Promise<WorkflowApprovalReceipt> {
    if (
      approval.runId !== run.id ||
      approval.workflowVersionId !== run.versionId ||
      approval.workflowId !== run.workflowId ||
      approval.status !== "pending" ||
      (approved && !approval.supported)
    )
      throw new Error("Approval is not reviewable");
    const result = parseWorkflowApprovalReceipt(
      await this.request(
        `/api/workflow/executions/${encodeURIComponent(run.id)}/approvals/${encodeURIComponent(approval.nodeId)}/${approval.iteration}`,
        {
          approved,
          expectedVersionId: run.versionId,
          requestDigest: approval.requestDigest,
        },
        signal,
      ),
      run,
    );
    const confirmed = result.approvals.find(
      (a) =>
        a.nodeId === approval.nodeId &&
        a.iteration === approval.iteration &&
        a.requestDigest === approval.requestDigest,
    );
    if (confirmed?.status !== (approved ? "approved" : "denied"))
      throw new Error("Decision not confirmed");
    return result;
  }

  // Metadata edits.
  private metadataResult(
    value: unknown,
    id: string,
    version: string,
    mutationId: string,
  ): WorkflowMetadataReceipt {
    const p = obj(value);
    if (
      p.workflowId !== id ||
      p.previousVersionId !== version ||
      p.mutationId !== mutationId ||
      typeof p.name !== "string" ||
      !p.name.trim() ||
      p.name.length > 200 ||
      typeof p.description !== "string" ||
      p.description.length > 4000 ||
      typeof p.active !== "boolean"
    )
      throw new Error("Metadata receipt mismatch");
    return {
      workflowId: id,
      previousVersionId: version,
      mutationId,
      versionId: str(p.versionId),
      name: p.name,
      description: p.description,
      active: p.active,
      appliedAt: str(p.appliedAt),
    };
  }
  /** `beforeSubmit` durably records the mutation identity before it is sent. */
  async changeMetadata(
    id: string,
    version: string,
    name: string,
    description: string,
    signal: AbortSignal,
    beforeSubmit: (mutationId: string) => void | Promise<void>,
  ): Promise<WorkflowMetadataReceipt> {
    if (!(await this.metadataSupported(signal)))
      throw new Error("Metadata editing unavailable");
    name = name.trim();
    if (!name || name.length > 200 || description.length > 4000)
      throw new Error("Invalid workflow metadata");
    signal.throwIfAborted();
    const mutationId = globalThis.crypto.randomUUID();
    await beforeSubmit(mutationId);
    signal.throwIfAborted();
    let data: Bag;
    try {
      data = obj(
        await this.request(
          `/api/workflow/workflows/${encodeURIComponent(id)}/metadata`,
          { mutationId, expectedVersionId: version, name, description },
          signal,
        ),
      );
    } catch (error) {
      if (
        refused(error, "WORKFLOW_METADATA_NOT_APPLIED", {
          workflowId: id,
          mutationId,
          expectedVersionId: version,
        })
      )
        throw new WorkflowMetadataRejected();
      throw error;
    }
    const receipt = this.metadataResult(data.receipt, id, version, mutationId);
    if (receipt.name !== name || receipt.description !== description)
      throw new Error("Metadata values mismatch");
    return receipt;
  }
  async reconcileMetadata(
    id: string,
    version: string,
    mutationId: string,
    signal: AbortSignal,
  ): Promise<WorkflowMetadataReceipt | null> {
    if (!(await this.metadataSupported(signal)))
      throw new Error("Metadata reconciliation unavailable");
    if (!UUID_V4.test(mutationId)) throw new Error("Invalid metadata mutation");
    const data = obj(
      await this.request(
        `/api/workflow/workflows/${encodeURIComponent(id)}/metadata-mutations/${mutationId}`,
        undefined,
        signal,
      ),
    );
    if (data.mutationId !== mutationId)
      throw new Error("Metadata identity mismatch");
    return data.receipt === null
      ? null
      : this.metadataResult(data.receipt, id, version, mutationId);
  }

  // Removal and restore.
  async removedWorkflows(signal: AbortSignal): Promise<RemoteWorkflow[]> {
    if (!(await this.lifecycleSupported(signal)))
      throw new Error("Removed workflow history unavailable");
    const p = obj(
      await this.request("/api/workflow/removed-workflows", undefined, signal),
    );
    if (!Array.isArray(p.workflows))
      throw new Error("Invalid removed workflows");
    return p.workflows.map((v: unknown) => {
      const w = parseRemoteWorkflow(v);
      if (!w.removed) throw new Error("Removed state mismatch");
      return w;
    });
  }
  private lifecycleResult(
    value: unknown,
    id: string,
    version: string,
    mutationId: string,
    operation: "remove" | "restore",
  ): WorkflowLifecycleReceipt | null {
    const p = obj(value);
    if (p.mutationId !== mutationId)
      throw new Error("Mutation identity mismatch");
    if (p.receipt === null) return null;
    const r = obj(p.receipt);
    if (
      r.workflowId !== id ||
      r.previousVersionId !== version ||
      r.mutationId !== mutationId ||
      r.operation !== operation
    )
      throw new Error("Lifecycle receipt mismatch");
    return {
      workflowId: id,
      previousVersionId: version,
      mutationId,
      operation,
      versionId: str(r.versionId),
      appliedAt: str(r.appliedAt),
    };
  }
  /** `beforeSubmit` durably records the mutation identity before it is sent. */
  async lifecycle(
    id: string,
    version: string,
    operation: "remove" | "restore",
    signal: AbortSignal,
    beforeSubmit: (mutationId: string) => void | Promise<void>,
  ): Promise<WorkflowLifecycleReceipt> {
    if (!(await this.lifecycleSupported(signal)))
      throw new Error("Reviewed removal unavailable");
    signal.throwIfAborted();
    const mutationId = globalThis.crypto.randomUUID();
    await beforeSubmit(mutationId);
    signal.throwIfAborted();
    let result: unknown;
    try {
      result = await this.request(
        `/api/workflow/workflows/${encodeURIComponent(id)}/lifecycle`,
        { mutationId, expectedVersionId: version, operation },
        signal,
      );
    } catch (error) {
      if (
        refused(error, "WORKFLOW_LIFECYCLE_NOT_APPLIED", {
          workflowId: id,
          mutationId,
          expectedVersionId: version,
        })
      )
        throw new WorkflowLifecycleRejected();
      throw error;
    }
    const receipt = this.lifecycleResult(
      result,
      id,
      version,
      mutationId,
      operation,
    );
    if (!receipt) throw new Error("Lifecycle outcome unknown");
    return receipt;
  }
  async reconcileLifecycle(
    id: string,
    version: string,
    mutationId: string,
    operation: "remove" | "restore",
    signal: AbortSignal,
  ): Promise<WorkflowLifecycleReceipt | null> {
    if (
      !(await this.lifecycleSupported(signal)) ||
      !["remove", "restore"].includes(operation) ||
      !UUID_V4.test(mutationId)
    )
      throw new Error("Invalid lifecycle reconciliation");
    return this.lifecycleResult(
      await this.request(
        `/api/workflow/workflows/${encodeURIComponent(id)}/lifecycle-mutations/${mutationId}`,
        undefined,
        signal,
      ),
      id,
      version,
      mutationId,
      operation,
    );
  }

  // Definitions, activation and runs.
  async list(signal: AbortSignal): Promise<RemoteWorkflow[]> {
    await this.ready(signal);
    const data = obj(
      await this.request("/api/workflow/workflows", undefined, signal),
    );
    if (!Array.isArray(data.workflows))
      throw new Error("Invalid workflow list");
    return data.workflows.map((x: unknown) => parseRemoteWorkflow(x));
  }
  async detail(id: string, signal: AbortSignal): Promise<RemoteWorkflow> {
    const workflow = parseRemoteWorkflow(
      await this.request(
        `/api/workflow/workflows/${encodeURIComponent(str(id))}`,
        undefined,
        signal,
      ),
    );
    if (workflow.id !== id) throw new Error("Workflow identity changed");
    return workflow;
  }
  async pause(id: string, signal: AbortSignal): Promise<RemoteWorkflow> {
    const workflow = parseRemoteWorkflow(
      await this.request(
        `/api/workflow/workflows/${encodeURIComponent(str(id))}/deactivate`,
        {},
        signal,
      ),
    );
    if (workflow.id !== id || workflow.active)
      throw new Error("Pause was not confirmed");
    return workflow;
  }
  /** Enables exactly the reviewed version: an agent with exact activation refuses a changed workflow atomically. */
  async activate(
    id: string,
    version: string,
    signal: AbortSignal,
  ): Promise<RemoteWorkflow> {
    const current = await this.detail(id, signal);
    if (current.versionId !== version)
      throw new Error("Workflow changed. Review it again before enabling.");
    const exact = await this.typedSchedulesSupported(signal);
    let response: unknown;
    try {
      response = await this.request(
        `/api/workflow/workflows/${encodeURIComponent(id)}/activate`,
        exact ? { expectedVersionId: version } : {},
        signal,
      );
    } catch (error) {
      if (
        exact &&
        refused(error, "WORKFLOW_ACTIVATION_NOT_APPLIED", {
          workflowId: id,
          expectedVersionId: version,
        })
      )
        throw new WorkflowActivationRejected();
      throw error;
    }
    const workflow = parseRemoteWorkflow(response);
    if (workflow.id !== id || !workflow.active)
      throw new Error("Activation was not confirmed");
    return workflow;
  }
  private async submit(
    id: string,
    version: string,
    submissionId: string | undefined,
    signal: AbortSignal,
  ): Promise<WorkflowRun> {
    let response: Bag;
    try {
      response = obj(
        await this.request(
          `/api/workflow/workflows/${encodeURIComponent(id)}/run`,
          {
            input: {},
            ...(submissionId
              ? { submissionId, expectedVersionId: version }
              : {}),
          },
          signal,
        ),
      );
    } catch (error) {
      if (
        submissionId &&
        refused(error, "WORKFLOW_VERSION_NOT_ADMITTED", {
          workflowId: id,
          submissionId,
          expectedVersionId: version,
        })
      )
        throw new WorkflowAdmissionRejected();
      throw error;
    }
    if (submissionId && response.submissionId !== submissionId)
      throw new Error("Submission identity mismatch");
    const run = parseWorkflowRun(response.execution);
    if (run.workflowId !== id || (submissionId && run.versionId !== version))
      throw new Error("Execution identity or reviewed version changed");
    return run;
  }
  /** `beforeSubmit` durably records the submission identity (absent on agents without one) before it is sent. */
  async run(
    id: string,
    version: string,
    signal: AbortSignal,
    beforeSubmit?: (submissionId?: string) => void | Promise<void>,
  ): Promise<WorkflowRun> {
    const current = await this.detail(id, signal);
    if (current.versionId !== version)
      throw new Error("Workflow changed. Review it again before running.");
    signal.throwIfAborted();
    const submissionId = (await this.supportsSubmissionReconciliation(signal))
      ? globalThis.crypto.randomUUID()
      : undefined;
    signal.throwIfAborted();
    await beforeSubmit?.(submissionId);
    signal.throwIfAborted();
    return this.submit(id, version, submissionId, signal);
  }
  /**
   * Sends one retained reviewed submission again under its original identity.
   * The agent admits a submission ID at most once, so this returns the run it
   * already started or starts that one run; it can never start a second.
   */
  async resubmit(
    id: string,
    version: string,
    submissionId: string,
    signal: AbortSignal,
  ): Promise<WorkflowRun> {
    if (!(await this.supportsSubmissionReconciliation(signal)))
      throw new Error("Agent does not support submission reconciliation");
    if (!UUID_V4.test(submissionId))
      throw new Error("Invalid retained submission");
    signal.throwIfAborted();
    return this.submit(id, version, submissionId, signal);
  }
  async reconcile(
    id: string,
    version: string,
    submissionId: string,
    signal: AbortSignal,
  ): Promise<WorkflowRun | null> {
    if (!(await this.supportsSubmissionReconciliation(signal)))
      throw new Error("Agent does not support submission reconciliation");
    if (!UUID_V4.test(submissionId))
      throw new Error("Invalid retained submission");
    const data = obj(
      await this.request(
        `/api/workflow/workflows/${encodeURIComponent(id)}/submissions/${submissionId}`,
        undefined,
        signal,
      ),
    );
    if (data.submissionId !== submissionId)
      throw new Error("Submission identity changed");
    if (data.execution === null) return null;
    const run = parseWorkflowRun(data.execution);
    if (run.workflowId !== id || run.versionId !== version)
      throw new Error("Reconciled execution mismatch");
    return run;
  }
  async executions(id: string, signal: AbortSignal): Promise<WorkflowRun[]> {
    const data = obj(
      await this.request(
        `/api/workflow/workflows/${encodeURIComponent(str(id))}/executions`,
        undefined,
        signal,
      ),
    );
    if (!Array.isArray(data.executions))
      throw new Error("Invalid execution list");
    return data.executions.map((x: unknown) => {
      const run = parseWorkflowRun(x);
      if (run.workflowId !== id) throw new Error("Execution identity mismatch");
      return run;
    });
  }
  /** Cancels an unfinished run; a run already finished is returned unchanged. */
  async cancel(
    id: string,
    workflowId: string,
    signal: AbortSignal,
  ): Promise<WorkflowRun> {
    const current = await this.receipt(id, workflowId, signal);
    if (current.finished) return current;
    const data = obj(
      await this.request(
        `/api/workflow/executions/${encodeURIComponent(id)}/cancel`,
        {},
        signal,
      ),
    );
    const run = parseWorkflowRun(data.execution);
    if (run.id !== id || run.workflowId !== workflowId)
      throw new Error("Cancellation identity mismatch");
    return run;
  }
  async receipt(
    id: string,
    workflowId: string,
    signal: AbortSignal,
  ): Promise<WorkflowRun> {
    const data = obj(
      await this.request(
        `/api/workflow/executions/${encodeURIComponent(str(id))}`,
        undefined,
        signal,
      ),
    );
    const run = parseWorkflowRun(data.execution);
    if (run.id !== id || run.workflowId !== workflowId)
      throw new Error("Execution identity mismatch");
    return run;
  }
}
