import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import { stableStringify, withActionGatePolicy } from "@elizaos/core";
import {
  executeRawSqlTx,
  sqlText,
  type TransactionalDb,
} from "../approval/sql.ts";
import { PgApprovalQueue } from "../approval/store.ts";
import type {
  ApprovalEnqueueResult,
  ApprovalRequest,
} from "../approval/types.ts";
import {
  CALENDAR_CAPABILITY,
  isCalendarOperation,
  validateCalendarResult,
} from "./calendar-contract.ts";
import {
  assertClockObservation,
  CLOCK_ALARMS_CAPABILITY,
  CLOCK_CAPABILITY,
  CLOCK_REPEAT_CAPABILITY,
  clockCapabilityAvailable,
  isClockOperation,
  validateClockResult,
} from "./clock-contract.ts";
import {
  DeviceActionError,
  type DeviceActionPayload,
  deviceOperationSupportedByCapabilities,
  exactKeys,
  identifier,
  object,
  text,
  validateDeviceOperation,
  validateDevicePayload,
} from "./contract.ts";
import {
  assertMapsObservation,
  isMapsOperation,
  MAPS_CAPABILITY,
  validateMapsResult,
} from "./maps-contract.ts";
import {
  isNotesOperation,
  NOTES_CAPABILITY,
  validateNotesResult,
} from "./notes-contract.ts";
import {
  isReminderOperation,
  REMINDER_CAPABILITY,
  REMINDER_TIMING_CAPABILITY,
  reminderCapabilityAvailable,
  validateReminderResult,
} from "./reminder-contract.ts";
import {
  isReminderCreate,
  REMINDER_CREATE_CAPABILITY,
  validateReminderCreateResult,
} from "./reminder-create-contract.ts";
import {
  type DeviceViewProfile,
  enabledDeviceViews,
  storedDeviceViewProfile,
} from "./view-profile.ts";

import {
  validateWorkflowBinding,
  validateWorkflowReadResult,
  type WorkflowDeviceBinding,
  type WorkflowDeviceDispatch,
} from "./workflow-contract.ts";

export interface DeviceCredential {
  subjectUserId: string;
  installationId: string;
  deviceKey: string;
  capabilities?: readonly string[];
}
interface TransactionDatabase extends TransactionalDb {
  transaction<T>(fn: (tx: TransactionalDb) => Promise<T>): Promise<T>;
}
interface DeviceTurn {
  runtime: IAgentRuntime;
  credential: DeviceCredential;
  active: boolean;
  viewProfile: DeviceViewProfile | null;
}
const turn = new AsyncLocalStorage<DeviceTurn>();
export function getDeviceActionTurn(): DeviceTurn | undefined {
  const current = turn.getStore();
  return current?.active ? current : undefined;
}
export async function withDeviceActionTurn<T>(
  runtime: IAgentRuntime,
  credential: DeviceCredential,
  fn: () => Promise<T>,
): Promise<T> {
  const viewProfile = await new DeviceActionService(runtime).viewProfile(
    credential,
  );
  const context = { runtime, credential, active: true, viewProfile };
  try {
    return await turn.run(context, () =>
      withActionGatePolicy((action) => {
        if (action.name === "PROPOSE_DEVICE_ACTION") return;
        const capabilities = credential.capabilities ?? [];
        const tags = action.tags ?? [];
        const nativeDomain =
          capabilities.includes(NOTES_CAPABILITY) &&
          tags.includes("resource:notes")
            ? "Notes"
            : capabilities.includes(CALENDAR_CAPABILITY) &&
                tags.includes("resource:calendar-records")
              ? "Calendar"
              : (capabilities.includes(REMINDER_CAPABILITY) ||
                    capabilities.includes(REMINDER_TIMING_CAPABILITY) ||
                    capabilities.includes(REMINDER_CREATE_CAPABILITY)) &&
                  tags.includes("resource:reminders-records")
                ? "reminders"
                : undefined;
        if (nativeDomain)
          return `This authenticated phone owns ${nativeDomain} records. Use PROPOSE_DEVICE_ACTION for its supported operations; native approval and a device receipt are required. Backend-store actions cannot substitute for device records.`;
      }, fn),
    );
  } finally {
    context.active = false;
  }
}
function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}
function keyHash(key: string): string {
  if (!/^[a-f0-9]{64}$/.test(key))
    throw new DeviceActionError("Invalid device credential");
  return createHash("sha256").update(key).digest("hex");
}
function scope(c: DeviceCredential, agentId: string): string {
  return `agent_id = ${sqlText(agentId)} AND subject_user_id = ${sqlText(text(c.subjectUserId, 256))} AND installation_id = ${sqlText(identifier(c.installationId))}`;
}
function transactionRuntime(
  runtime: IAgentRuntime,
  tx: TransactionalDb,
): IAgentRuntime {
  const adapter = new Proxy(runtime.adapter, {
    get(target, property) {
      return property === "db" ? tx : Reflect.get(target, property);
    },
  });
  return new Proxy(runtime, {
    get(target, property) {
      if (property === "adapter") return adapter;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
export function deviceProposalDigest(request: ApprovalRequest): string {
  return digest({
    id: request.id,
    subjectUserId: request.subjectUserId,
    payload: request.payload,
    expiresAt: request.expiresAt.toISOString(),
  });
}
export class DeviceActionService {
  constructor(private readonly runtime: IAgentRuntime) {}
  private database(): TransactionDatabase {
    const db = this.runtime.adapter.db as TransactionDatabase;
    if (!db || typeof db.transaction !== "function")
      throw new DeviceActionError(
        "Transactional device store unavailable",
        "DEVICE_STORE_UNAVAILABLE",
      );
    return db;
  }
  async register(
    c: DeviceCredential,
    label: string,
    workflowProtocol: 0 | 1 | 2 = 0,
    workflowOwnerId: string = c.subjectUserId,
  ): Promise<{
    installationId: string;
    enrollmentId: string;
    capabilities: string[];
    viewProfileVersion: 1;
    userTextFormatVersion: 1;
  }> {
    if (
      workflowProtocol !== 0 &&
      workflowProtocol !== 1 &&
      workflowProtocol !== 2
    )
      throw new DeviceActionError("Unsupported workflow device protocol");
    const hash = keyHash(c.deviceKey);
    return this.database().transaction(async (tx) => {
      await executeRawSqlTx(
        tx,
        `INSERT INTO client_devices (agent_id, subject_user_id, installation_id, enrollment_id, key_hash, label) VALUES (${sqlText(this.runtime.agentId)}, ${sqlText(text(c.subjectUserId, 256))}, ${sqlText(identifier(c.installationId))}, ${sqlText(randomUUID())}, ${sqlText(hash)}, ${sqlText(text(label, 128))}) ON CONFLICT DO NOTHING`,
      );
      const row = await this.lock(tx, c);
      await executeRawSqlTx(
        tx,
        `UPDATE client_devices SET workflow_protocol=${workflowProtocol}, workflow_owner_id=${sqlText(text(workflowOwnerId, 256))} WHERE ${scope(c, this.runtime.agentId)}`,
      );
      return {
        installationId: c.installationId,
        enrollmentId: String(row.enrollment_id),
        viewProfileVersion: 1,
        userTextFormatVersion: 1,
        capabilities: [
          "calendar.local-event.v1",
          "notes.local-record.v1",
          REMINDER_CAPABILITY,
          REMINDER_TIMING_CAPABILITY,
          REMINDER_CREATE_CAPABILITY,
          CLOCK_CAPABILITY,
          CLOCK_REPEAT_CAPABILITY,
          CLOCK_ALARMS_CAPABILITY,
          MAPS_CAPABILITY,
        ],
      };
    });
  }
  private async lock(
    tx: TransactionalDb,
    c: DeviceCredential,
  ): Promise<Record<string, unknown>> {
    const hash = keyHash(c.deviceKey);
    const rows = await executeRawSqlTx(
      tx,
      `SELECT agent_id, subject_user_id, installation_id, enrollment_id, key_hash, revoked, workflow_protocol, view_profile FROM client_devices WHERE ${scope(c, this.runtime.agentId)} FOR UPDATE`,
    );
    const row = rows[0];
    if (
      row?.revoked !== false ||
      typeof row.key_hash !== "string" ||
      row.key_hash.length !== hash.length ||
      !timingSafeEqual(Buffer.from(hash), Buffer.from(row.key_hash))
    )
      throw new DeviceActionError("Device unavailable");
    return row;
  }
  private async access<T>(
    c: DeviceCredential,
    fn: (
      queue: PgApprovalQueue,
      row: Record<string, unknown>,
      tx: TransactionalDb,
    ) => Promise<T>,
  ): Promise<T> {
    return this.database().transaction(async (tx) => {
      const row = await this.lock(tx, c);
      const queue = new PgApprovalQueue(transactionRuntime(this.runtime, tx), {
        agentId: this.runtime.agentId,
      });
      return fn(queue, row, tx);
    });
  }
  async authenticate(c: DeviceCredential): Promise<void> {
    await this.access(c, async () => {});
  }
  /** Canonical enrollment identity for a native journal, authenticated by the existing device store. */
  async context(c: DeviceCredential): Promise<{
    agentId: string;
    subjectUserId: string;
    installationId: string;
    enrollmentId: string;
    scope: string;
  }> {
    return this.access(c, async (_q, row) => {
      const identity = {
        agentId: identifier(row.agent_id),
        subjectUserId: text(row.subject_user_id, 256),
        installationId: identifier(row.installation_id),
        enrollmentId: identifier(row.enrollment_id),
      };
      return { ...identity, scope: digest(identity) };
    });
  }
  async viewProfile(c: DeviceCredential): Promise<DeviceViewProfile | null> {
    return this.access(c, async (_q, row) =>
      storedDeviceViewProfile(row.view_profile),
    );
  }
  async setViewProfile(
    c: DeviceCredential,
    input: unknown,
  ): Promise<DeviceViewProfile> {
    const value = object(input);
    exactKeys(value, ["version", "views", "expectedRevision"]);
    if (
      value.version !== 1 ||
      !(
        value.expectedRevision === null ||
        typeof value.expectedRevision === "string"
      )
    )
      throw new DeviceActionError("Unsupported view profile");
    const views = enabledDeviceViews(value.views);
    return this.access(c, async (_q, row, tx) => {
      const previous = storedDeviceViewProfile(row.view_profile);
      if ((previous?.revision ?? null) !== value.expectedRevision)
        throw new DeviceActionError("View profile changed");
      if (previous && JSON.stringify(previous.views) === JSON.stringify(views))
        return previous;
      const profile: DeviceViewProfile = {
        version: 1,
        revision: randomUUID(),
        views,
      };
      await executeRawSqlTx(
        tx,
        `UPDATE client_devices SET view_profile=${sqlText(JSON.stringify(profile))} WHERE ${scope(c, this.runtime.agentId)}`,
      );
      return profile;
    });
  }
  private assertViewProfile(
    row: Record<string, unknown>,
    payload: DeviceActionPayload,
  ): void {
    if (payload.operation.type !== "open_view") return;
    const profile = storedDeviceViewProfile(row.view_profile);
    if (
      profile
        ? profile.revision !== payload.viewProfileRevision ||
          !profile.views.includes(payload.operation.view)
        : payload.viewProfileRevision !== undefined
    )
      throw new DeviceActionError(
        "Enabled view profile changed or view unavailable",
      );
  }
  async revoke(c: DeviceCredential): Promise<void> {
    await this.access(c, async (_q, _row, tx) => {
      await executeRawSqlTx(
        tx,
        `UPDATE client_devices SET revoked = TRUE WHERE ${scope(c, this.runtime.agentId)}`,
      );
    });
  }
  async propose(
    c: DeviceCredential,
    operation: unknown,
    operationKey: string,
    reason: string,
    observation?: unknown,
  ): Promise<ApprovalRequest> {
    return (
      await this.proposeWithOutcome(
        c,
        operation,
        operationKey,
        reason,
        observation,
      )
    ).request;
  }
  /** Replay identity comes from the same durable queue transaction as insertion. */
  async proposeWithOutcome(
    c: DeviceCredential,
    operation: unknown,
    operationKey: string,
    reason: string,
    observation?: unknown,
  ): Promise<ApprovalEnqueueResult> {
    const validated = validateDeviceOperation(operation);
    if (!deviceOperationSupportedByCapabilities(validated.type, c.capabilities))
      throw new DeviceActionError("Device operation capability unavailable");
    if (
      isClockOperation(validated) &&
      !clockCapabilityAvailable(validated, c.capabilities)
    )
      throw new DeviceActionError("Clock capability unavailable");
    if (isMapsOperation(validated)) {
      if (!c.capabilities?.includes(MAPS_CAPABILITY))
        throw new DeviceActionError("Maps capability unavailable");
    }
    if (
      isReminderCreate(validated) &&
      !c.capabilities?.includes(REMINDER_CREATE_CAPABILITY)
    )
      throw new DeviceActionError("Reminder creation capability required");
    if (
      isReminderOperation(validated) &&
      !reminderCapabilityAvailable(validated, c.capabilities)
    )
      throw new DeviceActionError("Reminder capability unavailable");
    if (
      isNotesOperation(validated) &&
      !c.capabilities?.includes(NOTES_CAPABILITY)
    )
      throw new DeviceActionError("Notes capability unavailable");
    if (
      isCalendarOperation(validated) &&
      !c.capabilities?.includes(CALENDAR_CAPABILITY)
    )
      throw new DeviceActionError("Calendar capability unavailable");
    if (
      ![
        "clock_handoff",
        "clock_alarm",
        "create_note",
        "maps_read_selected",
        "notes_read_selected",
        "notes_update",
        "notes_delete",
        "create_reminder",
        "reminder_create",
        "reminder_read_selected",
        "reminder_update",
        "reminder_complete",
        "reminder_snooze",
        "reminder_cancel",
        "open_view",
        "browser_navigate",
        "calendar_create",
        "calendar_read_selected",
        "calendar_update",
        "calendar_delete",
      ].includes(validated.type)
    )
      throw new DeviceActionError("Workflow read requires bound dispatcher");
    return this.access(c, async (queue, row, tx) => {
      const viewProfile = storedDeviceViewProfile(row.view_profile);
      if (
        validated.type === "open_view" &&
        viewProfile &&
        !viewProfile.views.includes(validated.view)
      )
        throw new DeviceActionError("View unavailable on this installation");
      const payload: DeviceActionPayload = {
        action: "device_action",
        version: 1,
        installationId: c.installationId,
        enrollmentId: String(row.enrollment_id),
        operation: validated,
        ...(validated.type === "open_view" && viewProfile
          ? { viewProfileRevision: viewProfile.revision }
          : {}),
      };
      // This is the canonical queue's transaction API: no notification or effect before commit.
      const idempotencyKey = `device:${digest([c.subjectUserId, c.installationId, identifier(operationKey)])}`;
      const existing = await queue.byIdempotencyKey(
        idempotencyKey,
        c.subjectUserId,
      );
      if (isClockOperation(validated)) {
        const receipt = existing?.execution?.providerReceipt;
        const priorPayload = existing
          ? validateDevicePayload(existing.payload)
          : undefined;
        const historical =
          existing?.state === "done" &&
          priorPayload?.installationId === payload.installationId &&
          priorPayload?.enrollmentId === payload.enrollmentId &&
          stableStringify(priorPayload.operation) ===
            stableStringify(payload.operation) &&
          receipt?.outcome === "applied";
        try {
          if (historical) {
            validateClockResult(
              validated,
              receipt.result,
              "applied",
              typeof receipt.operationId === "string"
                ? receipt.operationId
                : undefined,
            );
            if (validated.type === "clock_alarm")
              payload.clockContextRevision = priorPayload.clockContextRevision;
          } else {
            const context = assertClockObservation(validated, observation);
            if (context) payload.clockContextRevision = context.alarmsRevision;
          }
        } catch {
          throw new DeviceActionError(
            "Clock observation unavailable or changed",
          );
        }
      }
      if (isMapsOperation(validated)) {
        const receipt = existing?.execution?.providerReceipt;
        const historical =
          existing?.state === "done" &&
          stableStringify(existing.payload) === stableStringify(payload) &&
          receipt &&
          typeof receipt === "object" &&
          !Array.isArray(receipt) &&
          receipt.outcome === "applied";
        if (historical) {
          // Exact canonical duplicate: return the approved historical snapshot,
          // never demand or read a newly selected object. Queue idempotency below
          // still rejects changed immutable proposal fields.
          validateMapsResult(validated, receipt.result);
        } else {
          try {
            assertMapsObservation(validated, observation);
          } catch {
            throw new DeviceActionError(
              "Maps observation unavailable or changed",
            );
          }
        }
      }
      const result = await queue.enqueueTransactional(
        {
          requestedBy: this.runtime.agentId,
          subjectUserId: c.subjectUserId,
          action: "device_action",
          payload,
          channel: "phone",
          reason: text(reason, 1000),
          idempotencyKey,
          expiresAt: existing?.expiresAt ?? new Date(Date.now() + 10 * 60_000),
        },
        tx,
      );
      return result;
    });
  }
  private async requireActiveWorkflow(
    tx: TransactionalDb,
    binding: WorkflowDeviceBinding,
  ): Promise<void> {
    const rows = await executeRawSqlTx(
      tx,
      `SELECT workflow_id, execution FROM workflow.embedded_executions WHERE agent_id = ${sqlText(this.runtime.agentId)} AND id = ${sqlText(binding.runId)} FOR UPDATE`,
    );
    const execution = object(rows[0]?.execution);
    if (
      rows[0]?.workflow_id !== binding.workflowId ||
      execution.workflowVersionId !== binding.versionId ||
      execution.finished === true ||
      execution.cancellationRequestedAt ||
      !["queued", "running", "waiting-approval"].includes(
        String(execution.status),
      )
    )
      throw new DeviceActionError(
        "Workflow is no longer accepting device decisions",
      );
  }
  async validateWorkflowTarget(
    subjectUserId: string,
    target: { installationId: string; enrollmentId: string },
    minimumProtocol = 1,
  ): Promise<void> {
    await this.database().transaction(async (tx) => {
      const rows = await executeRawSqlTx(
        tx,
        `SELECT enrollment_id,revoked,workflow_protocol FROM client_devices WHERE agent_id=${sqlText(this.runtime.agentId)} AND COALESCE(workflow_owner_id, subject_user_id)=${sqlText(text(subjectUserId, 256))} AND installation_id=${sqlText(identifier(target.installationId))} AND enrollment_id=${sqlText(target.enrollmentId)}`,
      );
      if (
        rows.length !== 1 ||
        rows[0]?.revoked !== false ||
        Number(rows[0]?.workflow_protocol) < minimumProtocol ||
        rows[0]?.enrollment_id !== target.enrollmentId
      )
        throw new DeviceActionError("Workflow device enrollment unavailable");
    });
  }
  /** Server-only dispatcher: authority derives from a persisted admitted run and its pinned spec. */
  async proposeForWorkflow(
    subjectUserId: string,
    dispatch: WorkflowDeviceDispatch,
  ): Promise<ApprovalRequest> {
    const binding = validateWorkflowBinding(dispatch.binding);
    const operation = validateDeviceOperation(dispatch.operation);
    return this.database().transaction(async (tx) => {
      const rows = await executeRawSqlTx(
        tx,
        `SELECT subject_user_id, enrollment_id, revoked, workflow_protocol FROM client_devices WHERE agent_id = ${sqlText(this.runtime.agentId)} AND COALESCE(workflow_owner_id, subject_user_id) = ${sqlText(text(subjectUserId, 256))} AND installation_id = ${sqlText(identifier(dispatch.target.installationId))} AND enrollment_id = ${sqlText(dispatch.target.enrollmentId)} FOR UPDATE`,
      );
      if (
        rows.length !== 1 ||
        rows[0]?.revoked !== false ||
        Number(rows[0]?.workflow_protocol) <
          (["post_notification", "speak_text"].includes(operation.type)
            ? 2
            : 1) ||
        rows[0]?.enrollment_id !== dispatch.target.enrollmentId
      )
        throw new DeviceActionError("Workflow device enrollment unavailable");

      const executions = await executeRawSqlTx(
        tx,
        `SELECT workflow_id, execution FROM workflow.embedded_executions WHERE agent_id = ${sqlText(this.runtime.agentId)} AND id = ${sqlText(binding.runId)} FOR UPDATE`,
      );
      const execution = object(executions[0]?.execution);
      if (
        executions[0]?.workflow_id !== binding.workflowId ||
        execution.workflowVersionId !== binding.versionId ||
        execution.finished === true ||
        execution.cancellationRequestedAt ||
        !["queued", "running", "waiting-approval"].includes(
          String(execution.status),
        )
      )
        throw new DeviceActionError(
          "Workflow run is unavailable for device dispatch",
        );
      const versions = await executeRawSqlTx(
        tx,
        `SELECT workflow FROM workflow.embedded_workflows WHERE agent_id = ${sqlText(this.runtime.agentId)} AND id = ${sqlText(binding.workflowId)} AND version_id = ${sqlText(binding.versionId)} UNION ALL SELECT workflow FROM workflow.workflow_revisions WHERE agent_id = ${sqlText(this.runtime.agentId)} AND workflow_id = ${sqlText(binding.workflowId)} AND version_id = ${sqlText(binding.versionId)}`,
      );
      const definition = object(versions[0]?.workflow),
        metadata = object(definition.metadata);
      if (
        metadata.elizaOwnerEntityId !== subjectUserId ||
        typeof metadata.elizaPhoneWorkflowSpec !== "string"
      )
        throw new DeviceActionError("Workflow owner binding unavailable");
      const spec = object(JSON.parse(metadata.elizaPhoneWorkflowSpec));
      if (
        createHash("sha256").update(JSON.stringify(spec)).digest("hex") !==
        binding.specDigest
      )
        throw new DeviceActionError("Workflow specification changed");
      const target = object(spec.device);
      if (
        target.installationId !== dispatch.target.installationId ||
        target.enrollmentId !== dispatch.target.enrollmentId
      )
        throw new DeviceActionError("Workflow device binding changed");
      const steps = Array.isArray(spec.steps) ? spec.steps : [];
      const step = object(
        steps.find((raw) => object(raw).id === binding.stepId),
      );
      if (operation.type === "create_note") {
        if (
          step.kind !== "Write" ||
          step.operation !== "save_note" ||
          step.title !== operation.title
        )
          throw new DeviceActionError("Workflow write scope changed");
      } else if (operation.type === "read_selected_notes") {
        if (
          step.kind !== "Read" ||
          step.operation !== "selected_notes" ||
          stableStringify(step.notes) !== stableStringify(operation.notes)
        )
          throw new DeviceActionError("Workflow selected Notes scope changed");
      } else if (operation.type === "read_calendar_range") {
        const { type: _type, ...range } = operation;
        if (
          step.kind !== "Read" ||
          step.operation !== "calendar_range" ||
          stableStringify(step.range) !== stableStringify(range)
        )
          throw new DeviceActionError("Workflow Calendar scope changed");
      } else if (operation.type === "post_notification") {
        if (
          step.kind !== "Notify" ||
          step.operation !== "app_notification" ||
          step.title !== operation.title
        )
          throw new DeviceActionError("Workflow notification scope changed");
      } else if (operation.type === "speak_text") {
        if (step.kind !== "Speak" || step.operation !== "read_aloud")
          throw new DeviceActionError("Workflow speech scope changed");
      } else
        throw new DeviceActionError("Unsupported workflow device operation");
      // Workflow ownership stays canonical; phone approvals retain the authenticated device subject.
      const deviceSubjectUserId = text(rows[0].subject_user_id, 256);
      const queue = new PgApprovalQueue(transactionRuntime(this.runtime, tx), {
        agentId: this.runtime.agentId,
      });
      const idempotencyKey = `workflow-device:${digest([subjectUserId, binding.runId, binding.stepId])}`;
      const existing = await queue.byIdempotencyKey(
        idempotencyKey,
        deviceSubjectUserId,
      );
      return (
        await queue.enqueueTransactional(
          {
            requestedBy: this.runtime.agentId,
            subjectUserId: deviceSubjectUserId,
            action: "device_action",
            payload: {
              action: "device_action",
              version: 1,
              installationId: dispatch.target.installationId,
              enrollmentId: dispatch.target.enrollmentId,
              workflow: binding,
              operation,
            },
            channel: "phone",
            reason: `Workflow ${String(definition.name)}: explicit device step review`,
            idempotencyKey,
            expiresAt:
              existing?.expiresAt ?? new Date(Date.now() + 10 * 60_000),
          },
          tx,
        )
      ).request;
    });
  }
  async list(c: DeviceCredential): Promise<ApprovalRequest[]> {
    return this.access(c, async (queue, row) =>
      (
        await queue.list({
          subjectUserId: c.subjectUserId,
          state: null,
          action: "device_action",
        })
      ).filter(
        (request) =>
          request.payload.action === "device_action" &&
          request.payload.installationId === c.installationId &&
          request.payload.enrollmentId === row.enrollment_id &&
          (deviceOperationSupportedByCapabilities(
            "open_view",
            c.capabilities,
          ) ||
            deviceOperationSupportedByCapabilities(
              validateDevicePayload(request.payload).operation.type,
              c.capabilities,
            )),
      ),
    );
  }
  private async proposal(
    queue: PgApprovalQueue,
    row: Record<string, unknown>,
    c: DeviceCredential,
    id: string,
    expectedDigest: string,
    activeWorkflowTx?: TransactionalDb,
  ): Promise<ApprovalRequest> {
    const request = await queue.byId(identifier(id), c.subjectUserId);
    if (!request) throw new DeviceActionError("Proposal unavailable");
    const payload = validateDevicePayload(request.payload);
    if (
      !deviceOperationSupportedByCapabilities(
        payload.operation.type,
        c.capabilities,
      )
    )
      throw new DeviceActionError("Device operation capability unavailable");
    if (
      isClockOperation(payload.operation) &&
      !clockCapabilityAvailable(payload.operation, c.capabilities)
    )
      throw new DeviceActionError("Clock capability unavailable");
    if (
      isMapsOperation(payload.operation) &&
      !c.capabilities?.includes(MAPS_CAPABILITY)
    )
      throw new DeviceActionError("Maps capability unavailable");
    if (
      isReminderCreate(payload.operation) &&
      !c.capabilities?.includes(REMINDER_CREATE_CAPABILITY)
    )
      throw new DeviceActionError("Reminder creation capability required");
    if (
      isReminderOperation(payload.operation) &&
      !reminderCapabilityAvailable(payload.operation, c.capabilities)
    )
      throw new DeviceActionError("Reminder capability unavailable");
    if (
      isNotesOperation(payload.operation) &&
      !c.capabilities?.includes(NOTES_CAPABILITY)
    )
      throw new DeviceActionError("Notes capability unavailable");
    if (
      isCalendarOperation(payload.operation) &&
      !c.capabilities?.includes(CALENDAR_CAPABILITY)
    )
      throw new DeviceActionError("Calendar capability unavailable");
    if (
      payload.installationId !== c.installationId ||
      payload.enrollmentId !== row.enrollment_id ||
      deviceProposalDigest(request) !== expectedDigest
    )
      throw new DeviceActionError("Proposal binding changed");
    if (
      activeWorkflowTx &&
      payload.workflow &&
      Number(row.workflow_protocol) <
        (["post_notification", "speak_text"].includes(payload.operation.type)
          ? 2
          : 1)
    )
      throw new DeviceActionError("Workflow device protocol unavailable");
    if (activeWorkflowTx && payload.workflow)
      await this.requireActiveWorkflow(activeWorkflowTx, payload.workflow);
    return request;
  }
  async decide(
    c: DeviceCredential,
    id: string,
    expectedDigest: string,
    approve: boolean,
  ): Promise<ApprovalRequest> {
    return this.access(c, async (q, row, tx) => {
      const request = await this.proposal(q, row, c, id, expectedDigest, tx);
      if (approve)
        this.assertViewProfile(row, validateDevicePayload(request.payload));
      const target = approve ? "approved" : "rejected";
      if (request.state === target) return request;
      if (
        request.state !== "pending" ||
        request.expiresAt.getTime() <= Date.now()
      )
        throw new DeviceActionError("Proposal is no longer pending");
      return q[approve ? "approve" : "reject"](id, c.subjectUserId, {
        resolvedBy: c.subjectUserId,
        resolutionReason: `Explicit device review:${expectedDigest}`,
      });
    });
  }
  async claim(
    c: DeviceCredential,
    id: string,
    expectedDigest: string,
  ): Promise<ApprovalRequest> {
    return this.access(c, async (q, row, tx) => {
      const request = await this.proposal(q, row, c, id, expectedDigest, tx);
      this.assertViewProfile(row, validateDevicePayload(request.payload));
      if (
        request.state !== "approved" ||
        request.expiresAt.getTime() <= Date.now() ||
        request.resolvedBy !== c.subjectUserId ||
        request.resolutionReason !== `Explicit device review:${expectedDigest}`
      )
        throw new DeviceActionError("Proposal cannot be claimed");
      const claimed = await q.claimExecution({
        requestId: id,
        subjectUserId: c.subjectUserId,
        provider: `device:${row.enrollment_id}`,
        providerIdempotencyKey: id,
      });
      if (!claimed.execution)
        throw new DeviceActionError(
          "Missing execution claim",
          "DEVICE_STORE_UNAVAILABLE",
        );
      // Commit dispatch before returning the permit. Lost responses require journal reconciliation, never another effect.
      return q.markDispatchStarted({
        requestId: id,
        subjectUserId: c.subjectUserId,
        attemptId: claimed.execution.attemptId,
      });
    });
  }
  async receipt(
    c: DeviceCredential,
    id: string,
    expectedDigest: string,
    attemptId: string,
    raw: unknown,
  ): Promise<ApprovalRequest> {
    const value = object(raw);
    exactKeys(value, ["outcome", "operationId", "code", "result"]);
    if (
      value.outcome !== "applied" &&
      value.outcome !== "failed" &&
      value.outcome !== "unknown"
    )
      throw new DeviceActionError("Invalid receipt outcome");
    let receipt: Record<string, unknown> = {
      outcome: value.outcome,
      ...(value.operationId === undefined
        ? {}
        : { operationId: identifier(value.operationId) }),
      ...(value.code === undefined ? {} : { code: identifier(value.code) }),
    };
    if (receipt.outcome === "applied" && !receipt.operationId)
      throw new DeviceActionError(
        "Applied receipt needs a native operation identifier",
      );
    return this.access(c, async (q, row) => {
      const request = await this.proposal(q, row, c, id, expectedDigest);
      const payload = validateDevicePayload(request.payload);
      if (
        isClockOperation(payload.operation) &&
        !clockCapabilityAvailable(payload.operation, c.capabilities)
      )
        throw new DeviceActionError("Clock capability unavailable");
      if (
        isMapsOperation(payload.operation) &&
        !c.capabilities?.includes(MAPS_CAPABILITY)
      )
        throw new DeviceActionError("Maps capability unavailable");
      if (
        isReminderCreate(payload.operation) &&
        !c.capabilities?.includes(REMINDER_CREATE_CAPABILITY)
      )
        throw new DeviceActionError("Reminder creation capability required");
      if (
        isReminderOperation(payload.operation) &&
        !reminderCapabilityAvailable(payload.operation, c.capabilities)
      )
        throw new DeviceActionError("Reminder capability unavailable");
      if (
        isNotesOperation(payload.operation) &&
        !c.capabilities?.includes(NOTES_CAPABILITY)
      )
        throw new DeviceActionError("Notes capability unavailable");
      const read =
        payload.operation.type === "read_selected_notes" ||
        payload.operation.type === "read_calendar_range";
      if (isClockOperation(payload.operation)) {
        try {
          if (receipt.outcome !== "unknown" || value.result !== undefined)
            receipt = {
              ...receipt,
              result: validateClockResult(
                payload.operation,
                value.result,
                receipt.outcome,
                typeof receipt.operationId === "string"
                  ? receipt.operationId
                  : undefined,
              ),
            };
        } catch {
          throw new DeviceActionError("Invalid Clock receipt");
        }
      } else if (
        isMapsOperation(payload.operation) &&
        receipt.outcome === "applied"
      ) {
        try {
          receipt = {
            ...receipt,
            result: validateMapsResult(payload.operation, value.result),
          };
        } catch {
          throw new DeviceActionError("Invalid Maps receipt");
        }
      } else if (
        (isReminderOperation(payload.operation) ||
          isReminderCreate(payload.operation)) &&
        receipt.outcome === "applied"
      ) {
        try {
          receipt = {
            ...receipt,
            result: isReminderCreate(payload.operation)
              ? validateReminderCreateResult(
                  payload.operation,
                  value.result,
                  identifier(receipt.operationId),
                )
              : validateReminderResult(payload.operation, value.result),
          };
        } catch {
          throw new DeviceActionError("Invalid reminder receipt");
        }
      } else if (
        isNotesOperation(payload.operation) &&
        receipt.outcome === "applied"
      ) {
        try {
          receipt = {
            ...receipt,
            result: validateNotesResult(payload.operation, value.result),
          };
        } catch {
          throw new DeviceActionError("Invalid Notes receipt");
        }
      } else if (
        isCalendarOperation(payload.operation) &&
        receipt.outcome === "applied"
      ) {
        try {
          receipt = {
            ...receipt,
            result: validateCalendarResult(payload.operation, value.result),
          };
        } catch {
          throw new DeviceActionError("Invalid Calendar receipt");
        }
      } else if (read && receipt.outcome === "applied") {
        receipt = {
          ...receipt,
          result: validateWorkflowReadResult(
            payload.operation as import("./workflow-contract.ts").WorkflowReadOperation,
            value.result,
          ),
        };
      } else if (value.result !== undefined)
        throw new DeviceActionError("Unexpected device read result");
      if (request.execution?.attemptId !== identifier(attemptId))
        throw new DeviceActionError("Execution attempt mismatch");
      if (
        request.state === "done" ||
        request.state === "reconciliation_required"
      ) {
        if (
          stableStringify(request.execution.providerReceipt) ===
          stableStringify(receipt)
        )
          return request;
        throw new DeviceActionError("Receipt conflicts with durable outcome");
      }
      const mutation = {
        requestId: id,
        subjectUserId: c.subjectUserId,
        attemptId,
        providerReceipt: receipt,
      };
      return receipt.outcome === "applied"
        ? q.markDone(mutation)
        : q.markReconciliationRequired({
            ...mutation,
            error: `Device outcome:${receipt.outcome}`,
          });
    });
  }
  /** A separate owner review settles uncertainty; it never re-dispatches. */
  async reconcile(
    c: DeviceCredential,
    id: string,
    expectedDigest: string,
    attemptId: string,
    raw: unknown,
  ): Promise<ApprovalRequest> {
    const value = object(raw);
    exactKeys(value, ["confirmed", "outcome", "operationId", "result"]);
    if (
      value.confirmed !== true ||
      (value.outcome !== "applied" && value.outcome !== "not_applied")
    )
      throw new DeviceActionError("Explicit outcome review required");
    let receipt: Record<string, unknown> = {
      outcome: value.outcome,
      ...(value.operationId === undefined
        ? {}
        : { operationId: identifier(value.operationId) }),
    };
    if (receipt.outcome === "applied" && !receipt.operationId)
      throw new DeviceActionError(
        "Applied outcome needs a native operation identifier",
      );
    return this.access(c, async (q, row) => {
      const request = await this.proposal(q, row, c, id, expectedDigest);
      const payload = validateDevicePayload(request.payload);
      if (
        isClockOperation(payload.operation) &&
        !clockCapabilityAvailable(payload.operation, c.capabilities)
      )
        throw new DeviceActionError("Clock capability unavailable");
      if (
        isMapsOperation(payload.operation) &&
        !c.capabilities?.includes(MAPS_CAPABILITY)
      )
        throw new DeviceActionError("Maps capability unavailable");
      if (
        isReminderCreate(payload.operation) &&
        !c.capabilities?.includes(REMINDER_CREATE_CAPABILITY)
      )
        throw new DeviceActionError("Reminder creation capability required");
      if (
        isReminderOperation(payload.operation) &&
        !reminderCapabilityAvailable(payload.operation, c.capabilities)
      )
        throw new DeviceActionError("Reminder capability unavailable");
      if (
        isNotesOperation(payload.operation) &&
        !c.capabilities?.includes(NOTES_CAPABILITY)
      )
        throw new DeviceActionError("Notes capability unavailable");
      if (isClockOperation(payload.operation)) {
        try {
          if (receipt.outcome !== "unknown" || value.result !== undefined)
            receipt = {
              ...receipt,
              result: validateClockResult(
                payload.operation,
                value.result,
                receipt.outcome,
                typeof receipt.operationId === "string"
                  ? receipt.operationId
                  : undefined,
              ),
            };
        } catch {
          throw new DeviceActionError("Invalid Clock receipt");
        }
      } else if (
        isMapsOperation(payload.operation) &&
        receipt.outcome === "applied"
      ) {
        try {
          receipt = {
            ...receipt,
            result: validateMapsResult(payload.operation, value.result),
          };
        } catch {
          throw new DeviceActionError("Invalid Maps receipt");
        }
      } else if (
        (isReminderOperation(payload.operation) ||
          isReminderCreate(payload.operation)) &&
        receipt.outcome === "applied"
      ) {
        try {
          receipt = {
            ...receipt,
            result: isReminderCreate(payload.operation)
              ? validateReminderCreateResult(
                  payload.operation,
                  value.result,
                  identifier(receipt.operationId),
                )
              : validateReminderResult(payload.operation, value.result),
          };
        } catch {
          throw new DeviceActionError("Invalid reminder receipt");
        }
      } else if (
        isNotesOperation(payload.operation) &&
        receipt.outcome === "applied"
      ) {
        try {
          receipt = {
            ...receipt,
            result: validateNotesResult(payload.operation, value.result),
          };
        } catch {
          throw new DeviceActionError("Invalid Notes receipt");
        }
      } else if (
        isCalendarOperation(payload.operation) &&
        receipt.outcome === "applied"
      ) {
        try {
          receipt = {
            ...receipt,
            result: validateCalendarResult(payload.operation, value.result),
          };
        } catch {
          throw new DeviceActionError("Invalid Calendar receipt");
        }
      } else if (
        (payload.operation.type === "read_selected_notes" ||
          payload.operation.type === "read_calendar_range") &&
        receipt.outcome === "applied"
      ) {
        receipt = {
          ...receipt,
          result: validateWorkflowReadResult(payload.operation, value.result),
        };
      } else if (value.result !== undefined)
        throw new DeviceActionError("Unexpected reconciliation read result");
      if (request.execution?.attemptId !== identifier(attemptId))
        throw new DeviceActionError("Execution attempt mismatch");
      if (
        (request.state === "done" || request.state === "retryable") &&
        request.execution.reconciledBy === c.subjectUserId &&
        stableStringify(request.execution.providerReceipt) ===
          stableStringify(receipt)
      )
        return request;
      if (request.state !== "reconciliation_required")
        throw new DeviceActionError("No uncertain outcome to reconcile");
      return q.reconcileExecution({
        requestId: id,
        subjectUserId: c.subjectUserId,
        attemptId,
        outcome: receipt.outcome === "applied" ? "delivered" : "not_delivered",
        reconciledBy: c.subjectUserId,
        reconciliationReason:
          "Explicit owner review of native operation journal",
        providerReceipt: receipt,
      });
    });
  }
}
