import { BillCodeCoordinator } from "./bill-code-coordinator.mjs";
import {
  createPdfBillParser,
  pdfBillAttachmentPolicy,
} from "./bill-pdf-parser.mjs";
import { BillSourceDiscovery } from "./bill-source-discovery.mjs";
import { BillWorkflow } from "./bill-workflow.mjs";
import { BillHostError } from "./errors.mjs";

const ownerKey = (owner) =>
  JSON.stringify([
    owner.actorId,
    owner.agentId,
    owner.connector.source,
    owner.connector.accountId,
  ]);
/** Trusted host composition. All bill/provider policy comes from reviewed server configuration. */
export function createBillHelperHost({
  deriveBillDecision,
  runtimeModule,
  target,
  credentialGate,
  authorizeGoal,
  billForTask,
  policyForTask,
  verify,
  recordEvidence,
  reconcileMethod,
  google,
  billDiscovery,
  controls,
  selectionGuidance,
}) {
  for (const value of [
    runtimeModule?.NativeTaskActuator,
    credentialGate,
    authorizeGoal,
    billForTask,
    policyForTask,
    verify,
    recordEvidence,
  ])
    if (typeof value !== "function")
      throw new BillHostError("Incomplete bill helper host configuration");
  if (reconcileMethod != null && typeof reconcileMethod !== "function")
    throw new BillHostError("Invalid bill reconciliation policy");
  if (typeof deriveBillDecision !== "function")
    throw new BillHostError("Reviewed bill observation policy is required");
  if (
    !target ||
    typeof target.bindTask !== "function" ||
    typeof target.execute !== "function" ||
    typeof target.guideTask !== "function"
  )
    throw new BillHostError("A task-capable browser target is required");
  if (
    google &&
    [
      runtimeModule.GoogleTaskCodeResolver,
      google.accountForTask,
      google.challengeForBill,
      google.parse,
    ].some((value) => typeof value !== "function")
  )
    throw new BillHostError("Incomplete Google verification configuration");
  if (
    billDiscovery &&
    (typeof billDiscovery.scopeForTask !== "function" ||
      typeof billDiscovery.parse !== "function")
  )
    throw new BillHostError("Incomplete bill discovery configuration");
  const parseAttachment = billDiscovery?.pdf
    ? createPdfBillParser(billDiscovery.pdf)
    : billDiscovery?.parseAttachment;
  const attachmentPolicy =
    billDiscovery?.attachmentPolicy ??
    (billDiscovery?.pdf ? pdfBillAttachmentPolicy : undefined);
  const owned = new Map();
  let closed = false;
  const requireOwner = async (owner) => {
    if (closed || (await credentialGate()) !== owner.actorId)
      throw new BillHostError("Bill helper account unavailable");
  };
  return {
    requiresBillSelection: Boolean(billDiscovery),
    async authorizeGoal(goalRef, owner) {
      await requireOwner(owner);
      const goal = await authorizeGoal(goalRef, owner);
      await requireOwner(owner);
      return goal;
    },
    actuatorFactory(host) {
      if (closed) throw new BillHostError("Bill helper is closed");
      const key = ownerKey(host.owner);
      if (owned.has(key))
        throw new BillHostError("Bill helper owner already composed");
      const entry = {
        ...host,
        coordinator: null,
        resolver: null,
        runtime: null,
        actuator: null,
        discovery: null,
      };
      const actuator = new runtimeModule.NativeTaskActuator({
        ...host,
        target,
        policy: (task) => policyForTask(task),
        resolveValue: async (reference, task) => {
          await requireOwner(host.owner);
          if (!entry.coordinator)
            throw new BillHostError("Protected code resolution unavailable");
          return entry.coordinator.resolveValue(reference, task);
        },
        verify: async (...args) => {
          await requireOwner(host.owner);
          if (entry.billRecord?.taskId !== args[0].taskId)
            throw new BillHostError("Unbound verification bill");
          return verify(...args, entry.billRecord.bill);
        },
        reconcile: async (task, proposal, snapshot) => {
          await requireOwner(host.owner);
          const recovery = entry.recovery;
          if (
            !reconcileMethod ||
            !recovery ||
            recovery.taskId !== task.id ||
            recovery.operationId !== proposal.id
          )
            throw new BillHostError("Unbound bill recovery");
          const result = await reconcileMethod({
            task,
            proposal,
            snapshot,
            record: recovery.record,
            bill: recovery.bill,
          });
          await requireOwner(host.owner);
          return result;
        },
        recordEvidence: async (...args) => {
          await requireOwner(host.owner);
          return recordEvidence(...args);
        },
      });
      const quiesce = actuator.quiesce.bind(actuator);
      actuator.quiesce = async (context) => {
        const task = host.getTask(context.taskId);
        if (
          task.authorization.state !== "active" ||
          ["paused", "cancelled", "completed", "blocked"].includes(task.status)
        ) {
          entry.coordinator?.revoke();
          entry.discovery?.revoke();
        }
        return quiesce(context);
      };
      entry.actuator = actuator;
      owned.set(key, entry);
      return actuator;
    },
    reconcileTask: reconcileMethod
      ? async ({
          runtime,
          task,
          outcomes,
          sourceSelection,
          stillAuthorized,
        }) => {
          await requireOwner(runtime.owner);
          if (!reconcileMethod)
            throw new BillHostError("Bill reconciliation unavailable");
          const entry = owned.get(ownerKey(runtime.owner));
          if (
            !entry ||
            entry.recovery ||
            (entry.runtime && entry.runtime !== runtime)
          )
            throw new BillHostError("Bill recovery unavailable");
          const unknown = task.operations.filter(
            (op) => op.status === "unknown",
          );
          if (unknown.length !== 1)
            throw new BillHostError("No single unknown operation");
          if (
            billDiscovery &&
            (!sourceSelection ||
              sourceSelection.taskId !== task.id ||
              !task.allowedOrigins.includes(
                sourceSelection.candidate?.facts?.origin,
              ))
          )
            throw new BillHostError("Missing saved source selection");
          const bill = billDiscovery
            ? {
                ...sourceSelection.candidate.facts,
                sourceRef: sourceSelection.candidate.sourceRef,
              }
            : billForTask(task);
          const operationId = unknown[0].proposal.id;
          const recovery = {
            taskId: task.id,
            operationId,
            record: outcomes.loadMethodSelection(operationId),
            bill: structuredClone(bill),
          };
          entry.runtime = runtime;
          entry.recovery = recovery;
          try {
            return await runtime.reconcile(
              task.id,
              task.revision,
              operationId,
              stillAuthorized,
            );
          } finally {
            if (entry.recovery === recovery) entry.recovery = null;
          }
        }
      : undefined,
    async discoverBills({ runtime, task, signal }) {
      if (!billDiscovery) throw new BillHostError("Bill discovery unavailable");
      await requireOwner(runtime.owner);
      const entry = owned.get(ownerKey(runtime.owner));
      if (!entry || (entry.runtime && entry.runtime !== runtime))
        throw new BillHostError("Unbound bill helper runtime");
      entry.runtime = runtime;
      const contextFor = async (current) => ({
        ...(await billDiscovery.scopeForTask(current)),
        actorId: current.owner.actorId,
        agentId: current.owner.agentId,
        taskId: current.id,
        epoch: current.epoch,
      });
      const context = await contextFor(runtime.get(task.id));
      if (!entry.discovery)
        entry.discovery = new BillSourceDiscovery({
          google: billDiscovery.google,
          parse: billDiscovery.parse,
          attachmentPolicy,
          parseAttachment,
          maxAttachmentBytes: billDiscovery.maxAttachmentBytes,
          authorize: async (c) => {
            try {
              await requireOwner(runtime.owner);
              const currentContext = await contextFor(runtime.get(c.taskId));
              await requireOwner(runtime.owner);
              const current = runtime.get(c.taskId);
              return (
                current.owner.actorId === c.actorId &&
                current.owner.agentId === c.agentId &&
                current.epoch === c.epoch &&
                current.authorization.state === "active" &&
                ["active", "waiting"].includes(current.status) &&
                current.allowedOrigins.includes(c.providerOrigin) &&
                JSON.stringify(currentContext) === JSON.stringify(c)
              );
            } catch {
              return false;
            }
          },
        });
      return entry.discovery.discover(context, signal);
    },
    workflowFactory({
      runtime,
      task,
      outcomes,
      sourceSelection,
      signal,
      stillAuthorized,
    }) {
      if (closed) throw new BillHostError("Bill helper is closed");
      if (
        billDiscovery &&
        (!sourceSelection ||
          sourceSelection.taskId !== task.id ||
          !task.allowedOrigins.includes(
            sourceSelection.candidate?.facts?.origin,
          ))
      )
        throw new BillHostError("Select a source bill first");
      const entry = owned.get(ownerKey(runtime.owner));
      if (!entry || (entry.runtime && entry.runtime !== runtime))
        throw new BillHostError("Unbound bill helper runtime");
      entry.runtime = runtime;
      if (google && !entry.coordinator) {
        entry.resolver = new runtimeModule.GoogleTaskCodeResolver({
          google: google.service,
          parse: google.parse,
          authorize: async (context) => {
            try {
              await requireOwner(runtime.owner);
              const account = await google.accountForTask(
                runtime.get(context.taskId),
              );
              await requireOwner(runtime.owner);
              const current = runtime.get(context.taskId);
              return (
                current.owner.actorId === context.actorId &&
                current.owner.agentId === context.agentId &&
                current.epoch === context.epoch &&
                current.authorization.state === "active" &&
                ["active", "waiting"].includes(current.status) &&
                current.allowedOrigins.includes(context.providerOrigin) &&
                account === context.accountId
              );
            } catch {
              return false;
            }
          },
        });
        entry.coordinator = new BillCodeCoordinator({
          deriveBillDecision,
          runtime,
          actuator: entry.actuator,
          resolver: entry.resolver,
          challengeProvider: google.challengeForBill,
          resolveGoogleAccount: google.accountForTask,
          stillAuthorized: async () => {
            try {
              await requireOwner(runtime.owner);
              return true;
            } catch {
              return false;
            }
          },
        });
      }
      const bill = billDiscovery
        ? {
            ...sourceSelection.candidate.facts,
            sourceRef: sourceSelection.candidate.sourceRef,
          }
        : billForTask(task);
      entry.billRecord = { taskId: task.id, bill: structuredClone(bill) };
      return new BillWorkflow({
        deriveBillDecision,
        runtime,
        actuator: entry.actuator,
        bill,
        taskId: task.id,
        outcomes,
        signal,
        stillAuthorized,
        controls,
        selectionGuidance,
        codeCoordinator: entry.coordinator,
      });
    },
    /** Call after the task gateway has quiesced owned browser work. */
    close() {
      closed = true;
      for (const entry of owned.values()) {
        entry.coordinator?.revoke();
        entry.discovery?.revoke();
      }
      owned.clear();
    },
  };
}
