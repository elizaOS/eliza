/** Captures, persists, and transfers complete sandbox backup state under the caller’s existing lifecycle transaction. Transport and lifecycle locks remain explicit host boundaries; no replacement provider or database connection is created. */

import { ElizaError, toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import {
  MAX_RESTORABLE_AGENT_BACKUP_BYTES,
  SnapshotPayloadTooLargeError,
} from "@elizaos/shared/agent-backup-limits";
import { and, eq, inArray, sql } from "drizzle-orm";
import { dbWrite } from "../../../../db/helpers";
import {
  type AgentBackupSnapshotType,
  type AgentSandbox,
  type AgentSandboxBackupMetadata,
  agentSandboxesRepository,
  hydrateAgentSandboxBackup,
  prepareAgentBackupInsertData,
} from "../../../../db/repositories/agent-sandboxes";
import {
  type AgentBackupStateData,
  agentSandboxBackups,
  agentSandboxes,
  CONTAINER_BACKED_EXECUTION_TIERS,
  type NewAgentSandboxBackup,
  type StoredAgentSandboxBackup,
} from "../../../../db/schemas/agent-sandboxes";
import { logger } from "../../../utils/logger";
import {
  computeStateHash,
  estimateDeltaBytes,
  incrementalChainDepth,
  planIncrementalBackup,
  resolveBackupChainBytes,
} from "../../agent-backup-diff";
import { SandboxTransport } from "../bridge/transport.js";
import { LifecycleTx } from "../lifecycle/transaction.js";
import {
  SNAPSHOT_AUTHORITY_CHANGED,
  SnapshotAuthorityCapture,
  snapshotAuthorityRejection,
  snapshotCaptureStillCanonical,
} from "./authority.js";
import {
  AGENT_SNAPSHOT_CAPTURE_TRANSIENT_CODE,
  MAX_BACKUPS,
  SNAPSHOT_CAPTURE_TRANSIENT,
  SNAPSHOT_ENDPOINT_UNSUPPORTED,
  SNAPSHOT_FETCH_TIMEOUT_MS,
  SNAPSHOT_RESTORE_TIMEOUT_MS,
  SnapshotResult,
} from "./contracts.js";
import {
  assertSnapshotExpandedBudgets,
  readBodyWithinBudget,
  readErrorBodyExcerpt,
  SNAPSHOT_MAX_RAW_BYTES,
} from "./transfer-limits.js";

export interface SandboxBackupHost {
  lockLifecycle(tx: LifecycleTx, agentId: string, orgId: string): Promise<void>;
  getAgentForLifecycleMutation(
    tx: LifecycleTx,
    agentId: string,
    orgId: string,
  ): Promise<AgentSandbox | undefined>;
  fetchAgentApi(
    ...args: Parameters<SandboxTransport["fetchAgentApi"]>
  ): ReturnType<SandboxTransport["fetchAgentApi"]>;
  getSafeBridgeEndpoint(
    ...args: Parameters<SandboxTransport["getSafeBridgeEndpoint"]>
  ): ReturnType<SandboxTransport["getSafeBridgeEndpoint"]>;
  getAgentJsonHeaders(
    ...args: Parameters<SandboxTransport["getAgentJsonHeaders"]>
  ): ReturnType<SandboxTransport["getAgentJsonHeaders"]>;
}

export class SandboxBackup {
  constructor(private readonly host: SandboxBackupHost) {}

  // Snapshots

  async snapshot(
    agentId: string,
    orgId: string,
    type: AgentBackupSnapshotType = "manual",
  ): Promise<SnapshotResult> {
    // Both repository seams read the tenant-scoped primary. This is only an
    // early snapshot for avoiding network work, never a lock or CAS: authority
    // is re-read under the lifecycle lock after capture and backup planning.
    const rec =
      (await agentSandboxesRepository.findRunningSandbox(agentId, orgId)) ??
      (await agentSandboxesRepository.findByIdAndOrgForWrite(agentId, orgId));
    if (!rec) return { success: false, error: "Sandbox is not running" };

    const initialAuthorityRejection = snapshotAuthorityRejection(rec);
    if (initialAuthorityRejection) {
      return { success: false, error: initialAuthorityRejection };
    }
    if (rec.status !== "running" || !rec.bridge_url) {
      return { success: false, error: "Sandbox is not running" };
    }

    let stateData: AgentBackupStateData;
    let sizeBytes: number;
    try {
      ({ stateData, sizeBytes } = await this.fetchSnapshotState(rec));
    } catch (error) {
      // A bridge that lacks /api/snapshot (V2 image) returns the sentinel; an
      // auto backup against it is a benign skip, so surface it as a result the
      // snapshot job recognizes instead of a thrown, retried failure. All other
      // errors (real fetch/transport failures) still propagate.
      const message = error instanceof Error ? error.message : String(error);
      if (message === SNAPSHOT_ENDPOINT_UNSUPPORTED) {
        return { success: false, error: SNAPSHOT_ENDPOINT_UNSUPPORTED };
      }
      if (message === SNAPSHOT_CAPTURE_TRANSIENT) {
        return {
          success: false,
          error: SNAPSHOT_CAPTURE_TRANSIENT,
          retryable: true,
        };
      }
      throw error;
    }

    // Both labels gate a destructive follow-up — a rollback replays the
    // `pre-upgrade` point, and a relocation destroys the source container once
    // the `pre-move` capture is restored elsewhere. A partial capture would
    // survive either as silent data loss, so neither is accepted without a
    // full-agent manifest.
    if ((type === "pre-upgrade" || type === "pre-move") && !stateData.manifest) {
      return {
        success: false,
        error: `${type} snapshot did not include a full-agent manifest`,
      };
    }

    // Capture and incremental/full planning intentionally stay outside the
    // lifecycle transaction. No durable backup preparation or write begins
    // until the locked canonical row proves this exact capture still owns the
    // same running container generation.
    const plannedInput = await this.buildBackupInput(rec.id, type, stateData, sizeBytes);
    const persisted = await dbWrite.transaction(async (tx) => {
      await this.host.lockLifecycle(tx, agentId, orgId);
      const current = await this.host.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!current) {
        return { success: false as const, error: SNAPSHOT_AUTHORITY_CHANGED };
      }

      const currentAuthorityRejection = snapshotAuthorityRejection(current);
      if (currentAuthorityRejection) {
        return { success: false as const, error: currentAuthorityRejection };
      }
      if (current.status !== "running") {
        return { success: false as const, error: "Sandbox is not running" };
      }
      if (!snapshotCaptureStillCanonical(current, rec)) {
        return { success: false as const, error: SNAPSHOT_AUTHORITY_CHANGED };
      }

      const storedBackup = await this.persistAuthorizedSnapshotWithinTransaction(
        tx,
        current,
        orgId,
        type,
        plannedInput,
      );
      return { success: true as const, storedBackup };
    });

    if (!persisted.success) return persisted;

    const backup = await hydrateAgentSandboxBackup(persisted.storedBackup);
    await agentSandboxesRepository.pruneBackups(rec.id, MAX_BACKUPS);
    logger.info("[agent-sandbox] Backup created", {
      agentId,
      type,
      kind: backup.backup_kind,
      bytes: backup.size_bytes,
    });
    return { success: true, backup };
  }

  /**
   * Decide whether a new snapshot of `stateData` is stored as a full backup or
   * an incremental delta against the latest backup, and build the insert row.
   * Falls back to a full backup whenever there is no parent, the parent chain
   * can't be reconstructed, or the delta isn't worth it (see
   * `planIncrementalBackup`). Full-backup behaviour is byte-identical to the
   * pre-incremental path, so existing flows are unaffected.
   */
  async buildBackupInput(
    sandboxRecordId: string,
    type: AgentBackupSnapshotType,
    stateData: AgentBackupStateData,
    sizeBytes: number,
  ): Promise<NewAgentSandboxBackup> {
    const contentHash = computeStateHash(stateData);
    const latest = await agentSandboxesRepository.getLatestBackup(sandboxRecordId);
    if (latest) {
      try {
        const baseState = await agentSandboxesRepository.getReconstructedBackupState(latest.id);
        if (baseState) {
          const all = await agentSandboxesRepository.listBackups(sandboxRecordId, 1000);
          const nodes = all.map((b) => ({
            id: b.id,
            backupKind: b.backup_kind,
            parentBackupId: b.parent_backup_id,
            createdAtMs: b.created_at.getTime(),
            // Kept so the projected chain sum below needs no extra query.
            sizeBytes: b.size_bytes ?? null,
          }));
          const chainDepth = incrementalChainDepth(nodes, latest.id);
          const plan = planIncrementalBackup({ base: baseState, next: stateData, chainDepth });
          if (plan.kind === "incremental") {
            // retained-implies-restorable (#17172): reconstruction budgets the
            // SUM of the chain's stored inputs, so appending a delta that
            // pushes that sum past the ceiling would make this row canonical
            // AND unreconstructable in the same write — the invariant this PR
            // exists to hold. A full backup is always reconstructable, so it is
            // the correct fail-closed outcome, both when the projection
            // breaches and when it cannot be computed (an ancestor with an
            // unrecorded size_bytes).
            const deltaBytes = estimateDeltaBytes(plan.delta);
            const existingChainBytes = resolveBackupChainBytes(nodes, latest.id);
            if (
              existingChainBytes !== null &&
              existingChainBytes + deltaBytes <= MAX_RESTORABLE_AGENT_BACKUP_BYTES
            ) {
              return {
                sandbox_record_id: sandboxRecordId,
                snapshot_type: type,
                // The state_data jsonb holds a BackupDelta for incremental rows.
                state_data: plan.delta,
                size_bytes: deltaBytes,
                backup_kind: "incremental",
                parent_backup_id: latest.id,
                content_hash: contentHash,
              };
            }
            logger.info(
              "[agent-sandbox] Storing a full backup: an incremental would exceed the restorable chain budget",
              {
                sandboxRecordId,
                existingChainBytes,
                deltaBytes,
                limitBytes: MAX_RESTORABLE_AGENT_BACKUP_BYTES,
              },
            );
          }
        }
      } catch (error) {
        logger.warn("[agent-sandbox] Incremental planning failed; storing full backup", {
          sandboxRecordId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      sandbox_record_id: sandboxRecordId,
      snapshot_type: type,
      state_data: stateData,
      size_bytes: sizeBytes,
      backup_kind: "full",
      content_hash: contentHash,
    };
  }

  async listBackups(
    agentId: string,
    orgId: string,
    limit?: number,
  ): Promise<AgentSandboxBackupMetadata[]> {
    const rec = await agentSandboxesRepository.findByIdAndOrg(agentId, orgId);
    return rec ? agentSandboxesRepository.listBackupMetadata(rec.id, limit) : [];
  }

  async fetchSnapshotState(
    rec: Pick<
      AgentSandbox,
      | "id"
      | "bridge_url"
      | "health_url"
      | "node_id"
      | "bridge_port"
      | "web_ui_port"
      | "headscale_ip"
      | "sandbox_id"
      | "environment_vars"
    >,
  ): Promise<{
    stateData: AgentBackupStateData;
    sizeBytes: number;
    bridgeUrl: string;
  }> {
    if (!rec.bridge_url) {
      throw new Error("Sandbox is not running");
    }

    const res = await this.host.fetchAgentApi(rec, "/api/snapshot", {
      method: "POST",
      signal: AbortSignal.timeout(SNAPSHOT_FETCH_TIMEOUT_MS),
    });
    if (res.status === 404) {
      // The deployed agent image does not expose POST /api/snapshot (only the
      // cloud-agent template image does). Surface a recognizable sentinel so an
      // auto snapshot is skipped, not hard-failed-and-retried.
      throw new Error(SNAPSHOT_ENDPOINT_UNSUPPORTED);
    }
    if (res.status === 503) {
      let payload: { code?: unknown } | null = null;
      try {
        payload = (await res.clone().json()) as { code?: unknown };
      } catch {
        // error-policy:J3 an invalid upstream error body is not the structured
        // transient signal and therefore follows the ordinary HTTP failure.
        payload = null;
      }
      if (payload?.code === AGENT_SNAPSHOT_CAPTURE_TRANSIENT_CODE) {
        // TRANSIENT: only the agent's structured PGlite-closing code defers a
        // state-preserving restart. Unrelated runtime/proxy 503 responses keep
        // the ordinary failure path and bounded attempt policy.
        throw new Error(SNAPSHOT_CAPTURE_TRANSIENT);
      }
    }
    if (!res.ok) {
      // #18228: the snapshot transfer failed somewhere between the agent's HTTP
      // handler and this fetch — an agent-side 500 carries a diagnostic body
      // (the thrown message), while a bridge/proxy hop 500 carries a proxy
      // error page or an empty body. The Worker log previously reported only
      // the status code and discarded the body, making the two indistinguishable.
      // Read a bounded excerpt of the body and include it after the canonical
      // `Snapshot fetch failed: HTTP <status>` prefix so the existing
      // SNAPSHOT_HTTP_ERROR_SHAPE regex (anchored at the status) still classifies
      // it, while the operator sees where the hop failed.
      const excerpt = await readErrorBodyExcerpt(res);
      throw new Error(`Snapshot fetch failed: HTTP ${res.status}${excerpt ? ` ${excerpt}` : ""}`);
    }

    // Bounded hydration (#16639): stream and count — bytes past the raw
    // budget are never retained (fail-closed, no partial restore), and the
    // measured size comes from the counted stream instead of a re-stringify
    // that used to double peak memory.
    const raw = await readBodyWithinBudget(res, SNAPSHOT_MAX_RAW_BYTES);
    let stateData: AgentBackupStateData;
    try {
      stateData = JSON.parse(raw) as AgentBackupStateData;
    } catch {
      throw new Error("Snapshot payload is not valid JSON — refusing partial restore");
    }
    assertSnapshotExpandedBudgets(stateData);
    const sizeBytes = Buffer.byteLength(raw, "utf-8");

    return {
      stateData,
      sizeBytes,
      bridgeUrl: rec.bridge_url,
    };
  }

  async persistAuthorizedSnapshotWithinTransaction(
    tx: LifecycleTx,
    rec: SnapshotAuthorityCapture,
    organizationId: string,
    type: AgentBackupSnapshotType,
    plannedInput: NewAgentSandboxBackup,
  ): Promise<StoredAgentSandboxBackup> {
    const [sandbox] = await tx
      .update(agentSandboxes)
      .set({ last_backup_at: new Date(), updated_at: new Date() })
      .where(
        and(
          eq(agentSandboxes.id, rec.id),
          eq(agentSandboxes.organization_id, organizationId),
          eq(agentSandboxes.status, "running"),
          eq(agentSandboxes.execution_tier, rec.execution_tier),
          sql`${agentSandboxes.pool_status} IS NULL`,
          sql`${agentSandboxes.deleted_at} IS NULL`,
          sql`${agentSandboxes.deletion_attempt_id} IS NULL`,
          sql`${agentSandboxes.sandbox_id} IS NOT DISTINCT FROM ${rec.sandbox_id}`,
          sql`${agentSandboxes.node_id} IS NOT DISTINCT FROM ${rec.node_id}`,
          sql`${agentSandboxes.container_name} IS NOT DISTINCT FROM ${rec.container_name}`,
          sql`${agentSandboxes.bridge_url} IS NOT DISTINCT FROM ${rec.bridge_url}`,
          sql`${agentSandboxes.health_url} IS NOT DISTINCT FROM ${rec.health_url}`,
          sql`${agentSandboxes.bridge_port} IS NOT DISTINCT FROM ${rec.bridge_port}`,
          sql`${agentSandboxes.web_ui_port} IS NOT DISTINCT FROM ${rec.web_ui_port}`,
          sql`${agentSandboxes.headscale_ip} IS NOT DISTINCT FROM ${rec.headscale_ip}`,
          eq(agentSandboxes.environment_revision, rec.environment_revision),
          eq(agentSandboxes.lifecycle_revision, rec.lifecycle_revision),
        ),
      )
      .returning({ id: agentSandboxes.id });
    if (!sandbox) {
      throw new ElizaError("Backup metadata update lost its sandbox row", {
        code: "AGENT_BACKUP_SANDBOX_MISSING",
        context: { sandboxRecordId: rec.id, organizationId, snapshotType: type },
        severity: "fatal",
      });
    }

    // Preparation is deliberately after the locked metadata CAS so lost
    // authority cannot reach encryption or object storage. A provider PUT
    // cannot be rolled back if the later SQL insert/commit fails; that remains
    // the existing object-GC residual, not cross-system atomicity.
    const insertData = await prepareAgentBackupInsertData(plannedInput, organizationId);
    const [backup] = await tx.insert(agentSandboxBackups).values(insertData).returning();
    if (!backup) {
      throw new ElizaError("Backup insert did not return the persisted row", {
        code: "AGENT_BACKUP_INSERT_MISSING",
        context: { sandboxRecordId: rec.id, organizationId, snapshotType: type },
        severity: "fatal",
      });
    }
    return backup;
  }

  async persistSnapshotWithinTransaction(
    tx: LifecycleTx,
    sandboxRecordId: string,
    organizationId: string,
    type: AgentBackupSnapshotType,
    stateData: AgentBackupStateData,
    sizeBytes: number,
  ): Promise<{ backupId: string; lifecycleRevision: number }> {
    const [backup] = await tx
      .insert(agentSandboxBackups)
      .values(
        await prepareAgentBackupInsertData(
          {
            sandbox_record_id: sandboxRecordId,
            snapshot_type: type,
            state_data: stateData,
            size_bytes: sizeBytes,
          },
          organizationId,
        ),
      )
      .returning();

    if (!backup) {
      throw new ElizaError("Backup insert did not return the persisted row", {
        code: "AGENT_BACKUP_INSERT_MISSING",
        context: { sandboxRecordId, organizationId, snapshotType: type },
        severity: "fatal",
      });
    }
    const [sandbox] = await tx
      .update(agentSandboxes)
      .set({ last_backup_at: new Date(), updated_at: new Date() })
      .where(
        and(
          eq(agentSandboxes.id, sandboxRecordId),
          eq(agentSandboxes.organization_id, organizationId),
          inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS]),
        ),
      )
      .returning({ lifecycleRevision: agentSandboxes.lifecycle_revision });
    if (!sandbox) {
      throw new ElizaError("Backup metadata update lost its sandbox row", {
        code: "AGENT_BACKUP_SANDBOX_MISSING",
        context: { sandboxRecordId, organizationId, snapshotType: type, backupId: backup.id },
        severity: "fatal",
      });
    }

    logger.info("[agent-sandbox] Backup created", {
      agentId: sandboxRecordId,
      type,
      bytes: backup.size_bytes ?? sizeBytes,
    });
    return { backupId: backup.id, lifecycleRevision: sandbox.lifecycleRevision };
  }

  async pushState(
    sandboxOrBridgeUrl:
      | Pick<
          AgentSandbox,
          | "id"
          | "bridge_url"
          | "health_url"
          | "node_id"
          | "bridge_port"
          | "web_ui_port"
          | "headscale_ip"
          | "sandbox_id"
          | "environment_vars"
        >
      | string,
    state: AgentBackupStateData,
    options?: {
      trusted?: boolean;
      // Bridge-URL callers pass a bare string, so `pushState` cannot derive the
      // agent's ELIZA_API_TOKEN from it and the trusted branch used to send no
      // auth header. That worked while `/api/restore` exempted trusted-bridge
      // requests, but the cloud agent image now requires the token even over the
      // tailnet (server-helpers-auth `isCloudProvisionedContainer()` disables the
      // local-trust exemption) — so an unauthenticated restore deterministically
      // 401s (#15261). Pass the sandbox record here to attach the token.
      authRec?: Pick<AgentSandbox, "id" | "environment_vars">;
    },
  ) {
    // Measure the assembled payload ONCE, before it leaves the worker (#17172).
    // `/api/restore` caps its request body at the same canonical limit, so an
    // oversized push is a guaranteed far-end rejection — and this runs on the
    // blue/green ROLLBACK path, where discovering that after the request is a
    // failed rollback rather than a clean refusal. Stringifying into a local
    // also avoids building the payload twice.
    const body = JSON.stringify(state);
    const bodyBytes = Buffer.byteLength(body, "utf8");
    if (bodyBytes > MAX_RESTORABLE_AGENT_BACKUP_BYTES) {
      throw new SnapshotPayloadTooLargeError(bodyBytes, MAX_RESTORABLE_AGENT_BACKUP_BYTES);
    }
    const requestInit: RequestInit = {
      method: "POST",
      body,
      signal: AbortSignal.timeout(SNAPSHOT_RESTORE_TIMEOUT_MS),
    };
    const res =
      typeof sandboxOrBridgeUrl === "string"
        ? await fetch(
            await this.host.getSafeBridgeEndpoint(sandboxOrBridgeUrl, "/api/restore", options),
            {
              ...requestInit,
              headers: options?.authRec
                ? this.host.getAgentJsonHeaders(options.authRec)
                : { "Content-Type": "application/json" },
            },
          )
        : await this.host.fetchAgentApi(sandboxOrBridgeUrl, "/api/restore", requestInit);
    if (!res.ok) {
      // error-policy:J6 best-effort read of the restore error body to enrich
      // the error we throw next; a failed body read must not mask the status.
      const text = await res.text().catch((error) => {
        logger.warn("[agent-sandbox] Failed to read restore error body", {
          status: res.status,
          error: error instanceof Error ? error.message : String(error),
        });
        return "";
      });
      throw new Error(
        `State restore failed: HTTP ${res.status} ${truncateWellFormed(toWellFormedUnicode(text), 200)}`,
      );
    }
  }
}
