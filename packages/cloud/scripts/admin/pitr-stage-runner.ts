/** Stage-only composition. Protected entrypoint must supply fresh read-only authority capture. */
import { createHash, randomUUID } from "node:crypto";
import type { approveBackupForStage } from "./pitr-approved-backup-receipt";
import type { privatePitrApi } from "./pitr-private-api";
import { pitrPatchReceipt } from "./pitr-reviewed-patch";
import {
  OBSERVED_TEMPLATE,
  type StageSnapshot,
  stagePitrPolicyEngine,
} from "./pitr-reviewed-stage";
import { observedStageBucketBinding } from "./pitr-stage-bucket-binding";
import { prepareStageEvidence } from "./pitr-stage-evidence";
import { normalizeStageObservation } from "./pitr-stage-observation";

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
type Json = Parameters<typeof pitrPatchReceipt>[0];
function object(v: unknown): Record<string, Json> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw Error("stage_private_shape_invalid");
  return v as Record<string, Json>;
}
const WAL_NAMES = [
  "WAL_ARCHIVE_BUCKET",
  "WAL_ARCHIVE_ENDPOINT",
  "WAL_ARCHIVE_KEY",
  "WAL_ARCHIVE_SECRET",
  "WAL_ARCHIVE_REGION",
  "WAL_ARCHIVE_PATH",
];
export interface StageOnlyInput {
  directory: string;
  recipientPublicKey: string;
  projectId: string;
  environmentId: string;
  serviceId: string;
  sourceHead: string;
  volumeReceipt: string;
  imageReceipt: string;
  maintenanceReceipt: string;
  expiry: number;
  approvedBackup: ReturnType<typeof approveBackupForStage>;
  signal: AbortSignal;
  api: typeof privatePitrApi;
  sourceFresh: () => Promise<boolean>;
  /** Runs the already reviewed read-only authority audit and pinned CLI PITR status capture. */
  refreshAuthority: () => Promise<{
    authority: unknown;
    authorityObservedAtMs: number;
    pitr: unknown;
  }>;
  publish: (receipt: Record<string, unknown>) => void;
}
/** Production composition is fixed to the independently captured template. */
export async function runStageOnly(input: StageOnlyInput) {
  return runStageOnlyPolicyEngine(input, OBSERVED_TEMPLATE);
}
/** Synthetic fixtures may substitute the template receipt; production entrypoints must use runStageOnly. */
export async function runStageOnlyPolicyEngine(
  input: StageOnlyInput,
  templateReceipt: string,
  now: () => number = Date.now,
) {
  const action = { submitted: false };
  try {
    return await executeStageOnly(input, templateReceipt, now, action);
  } catch {
    return {
      purpose: "production_pitr_stage_only",
      state: action.submitted ? "creation_unconfirmed" : "refused_before_stage",
      automaticRetryAllowed: false,
      committed: false,
      resourceCreationPossible: action.submitted,
      productionMigrationReady: false,
    };
  }
}
async function executeStageOnly(
  input: StageOnlyInput,
  templateReceipt: string,
  now: () => number,
  action: { submitted: boolean },
) {
  const operationReceipt = sha(randomUUID());
  const seal = prepareStageEvidence({
    directory: input.directory,
    recipientPublicKey: input.recipientPublicKey,
    operationReceipt,
  });
  const persist = (name: string, value: unknown) => {
    const receipt = seal(name, value);
    input.publish({
      purpose: "pitr_stage_sealed_evidence",
      operationReceipt,
      ...receipt,
    });
  };
  const observations = new WeakMap<
    StageSnapshot,
    ReturnType<typeof normalizeStageObservation>
  >();
  let postCapture = 0;
  const capture = async () => {
    if (input.signal.aborted || !(await input.sourceFresh()))
      throw Error("stage_source_unavailable");
    const readStartedAt = now();
    const controller = new AbortController();
    const signal = AbortSignal.any([input.signal, controller.signal]);
    const names = ["environment", "project", "volumes", "staged"];
    const results = await Promise.allSettled(
      [
        input.api("environment", { id: input.environmentId }, signal),
        input.api("projectBuckets", { id: input.projectId }, signal),
        input.api("volumes", { id: input.environmentId }, signal),
        input.api("staged", { id: input.environmentId }, signal),
      ].map((p) =>
        p.catch((error) => {
          controller.abort();
          throw error;
        }),
      ),
    );
    const raw: Record<string, unknown> = {
      readStartedAt,
      reads: Object.fromEntries(
        results.flatMap((r, i) =>
          r.status === "fulfilled" ? [[names[i], r.value]] : [],
        ),
      ),
      unavailableReads: results.flatMap((r, i) =>
        r.status === "rejected" ? [names[i]] : [],
      ),
    };
    let sealed = false;
    const sealRaw = () => {
      if (!action.submitted || sealed) return;
      sealed = true;
      const filename =
        postCapture++ === 0
          ? "stage-raw-observation.json"
          : "stage-raw-reconciliation.json";
      persist(filename, raw);
    };
    try {
      if (results.some((r) => r.status !== "fulfilled"))
        throw Error("stage_read_unavailable");
      const [environment, project, volumes, staged] = results.map(
        (r) => (r as PromiseFulfilledResult<unknown>).value,
      );
      const edges = object(
        object(object(volumes).data).environment,
      ).volumeInstances;
      const nodes = object(edges).edges;
      if (!Array.isArray(nodes)) throw Error("stage_volume_invalid");
      const selected = nodes
        .map((e) => object(object(e).node))
        .filter(
          (n) => typeof n.id === "string" && sha(n.id) === input.volumeReceipt,
        );
      if (selected.length !== 1) throw Error("stage_volume_invalid");
      const listed = await input.api(
        "backupList",
        { id: selected[0].id },
        input.signal,
      );
      raw.backups = listed;
      const fresh = await input.refreshAuthority();
      raw.authority = fresh;
      // Preserve actual provider evidence even when interpretation/admission must refuse it.
      sealRaw();
      if (!(await input.sourceFresh())) throw Error("stage_source_unavailable");
      if (
        !Number.isFinite(readStartedAt) ||
        now() < readStartedAt ||
        now() - readStartedAt > 60000
      )
        throw Error("stage_capture_expired");
      const observation = normalizeStageObservation({
        projectId: input.projectId,
        environmentId: input.environmentId,
        serviceId: input.serviceId,
        sourceHead: input.sourceHead,
        expectedVolumeReceipt: input.volumeReceipt,
        expectedImageReceipt: input.imageReceipt,
        approvedBackup: input.approvedBackup,
        ...fresh,
        now: now(),
        environment,
        project,
        volumes,
        staged,
        backups: listed,
      });
      observation.snapshot.binding.observedAtMs = readStartedAt;
      observations.set(observation.snapshot, observation);
      return observation;
    } catch {
      sealRaw();
      throw Error("stage_observation_unavailable");
    }
  };
  const initial = await capture();
  const response = object(await input.api("template", {}, input.signal)),
    template = object(object(response.data).template);
  const serialized =
    typeof template.serializedConfig === "string"
      ? JSON.parse(template.serializedConfig)
      : template.serializedConfig;
  if (
    typeof template.id !== "string" ||
    sha(JSON.stringify(serialized)) !== templateReceipt
  )
    throw Error("stage_template_changed");
  const result = await stagePitrPolicyEngine(
    {
      now,
      serializedTemplate: serialized,
      review: {
        before: initial.snapshot,
        serializedTemplateSha256: templateReceipt,
        writerMaintenanceReceipt: input.maintenanceReceipt,
        operationReceipt,
        expiresAtMs: input.expiry,
        allowedVariableNames: WAL_NAMES,
      },
      transport: {
        snapshot: async () => (await capture()).snapshot,
        async persistIntent(review) {
          persist("stage-intent.json", {
            review,
            baseline: initial.privateConfig,
            inventory: initial.privateBuckets,
          });
          input.publish({
            purpose: "pitr_stage_intent",
            operationReceipt,
            templateReceipt,
            volumeReceipt: input.volumeReceipt,
            priorBucketReceipts: initial.snapshot.bucketIds.map(sha),
            automaticRetryAllowed: false,
          });
        },
        async stage(config, binding) {
          if (
            !(await input.sourceFresh()) ||
            input.signal.aborted ||
            now() >= input.expiry ||
            now() >= input.approvedBackup.validUntilMs ||
            (input.approvedBackup.expiresAtMs !== null &&
              now() >= input.approvedBackup.expiresAtMs) ||
            now() - binding.observedAtMs > 60000
          )
            throw Error("stage_action_admission_expired");
          action.submitted = true;
          const response = object(
            await input.api(
              "stageTemplate",
              {
                input: {
                  serializedConfig: config,
                  existingRootServiceId: input.serviceId,
                  environmentId: input.environmentId,
                  projectId: input.projectId,
                  workspaceId: initial.workspaceId,
                  templateId: template.id,
                  stageOnly: true,
                },
              },
              input.signal,
            ),
          );
          const operation = object(object(response.data).templateDeployV2);
          if (
            operation.projectId !== input.projectId ||
            typeof operation.workflowId !== "string" ||
            !operation.workflowId
          )
            throw Error("stage_creation_unconfirmed");
          persist("stage-workflow.json", operation);
          input.publish({
            purpose: "pitr_stage_workflow",
            operationReceipt,
            workflowReceipt: sha(operation.workflowId),
            automaticRetryAllowed: false,
          });
          return { workflowId: operation.workflowId };
        },
        async awaitComplete(id) {
          const deadline = now() + 600000;
          while (now() < deadline && !input.signal.aborted) {
            const result = object(
                await input.api("workflowStatus", { id }, input.signal),
              ),
              status = object(object(result.data).workflowStatus).status;
            if (status === "Complete") return true;
            if (status !== "Running" && status !== "NotFound") return false;
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
          return false;
        },
        async verifyBucketBinding(before, after, newBucketId) {
          const a = observations.get(before),
            b = observations.get(after);
          return (
            !!a &&
            !!b &&
            observedStageBucketBinding({
              beforeBuckets: a.privateBuckets,
              afterBuckets: b.privateBuckets,
              stagedPatch: after.stagedPatch,
              newBucketId,
              serviceId: input.serviceId,
              projectId: input.projectId,
            })
          );
        },
        async persistObservation(snapshot, owned) {
          const evidence = observations.get(snapshot);
          if (!evidence) throw Error("stage_observation_missing");
          persist("stage-observation.json", { ...evidence, owned });
          input.publish({
            purpose: "pitr_stage_observation",
            operationReceipt,
            patchReceipt: pitrPatchReceipt(snapshot.stagedPatch),
            ownedBucketReceipts: owned.map(sha),
            activeConfigReceipt: snapshot.binding.configSha256,
            automaticRetryAllowed: false,
          });
        },
      },
    },
    templateReceipt,
  );
  if (
    result.resourceCreationPossible &&
    result.state !== "staged_requires_review"
  ) {
    try {
      const observed = await capture();
      persist("stage-reconciliation.json", observed);
      input.publish({
        purpose: "pitr_stage_reconciliation",
        operationReceipt,
        addedBucketReceipts: observed.snapshot.bucketIds
          .filter((id) => !initial.snapshot.bucketIds.includes(id))
          .map(sha),
        removedBucketReceipts: initial.snapshot.bucketIds
          .filter((id) => !observed.snapshot.bucketIds.includes(id))
          .map(sha),
        activeConfigUnchanged:
          observed.snapshot.binding.configSha256 ===
          initial.snapshot.binding.configSha256,
        patchReceipt: pitrPatchReceipt(observed.snapshot.stagedPatch),
        ownershipProven: false,
        automaticRetryAllowed: false,
      });
    } catch {
      // error-policy:J1 No private provider error may reach the public receipt.
      try {
        input.publish({
          purpose: "pitr_stage_reconciliation",
          operationReceipt,
          state: "observation_unavailable",
          automaticRetryAllowed: false,
        });
      } catch {
        /* Preserve the existing unconfirmed result. */
      }
    }
  }
  return { ...result, purpose: "production_pitr_stage_only", operationReceipt };
}
