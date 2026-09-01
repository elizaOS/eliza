/**
 * Immutable parenting-agreement knowledge with reviewed citations and
 * resource-scoped guest access. Agreement bytes remain in the runtime's
 * content-addressed file service; this module stores only durable metadata,
 * review decisions, pins, and authorization bindings.
 */

import crypto from "node:crypto";
import {
  type EntityStore,
  KNOWLEDGE_GRAPH_SERVICE,
  resolveKnowledgeGraphService,
} from "@elizaos/agent";
import {
  DocumentService,
  ElizaError,
  type IAgentRuntime,
  type IFileStorageService,
  Service,
  ServiceType,
  type UUID,
} from "@elizaos/core";
import type { PdfCompleteDocument, PdfService } from "@elizaos/plugin-pdf";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import {
  executeRawSql,
  executeRawSqlTx,
  sqlInteger,
  sqlQuote,
  sqlText,
  toNumber,
  toText,
  withTransaction,
} from "../sql.js";
import {
  getHouseholdCoordinationService,
  HOUSEHOLD_COORDINATION_SERVICE,
  type HouseholdCoordinationService,
} from "./service.js";
import {
  DEFAULT_HOUSEHOLD_ID,
  HouseholdCoordinationError,
  normalizeHouseholdIdentifier,
} from "./types.js";

export const HOUSEHOLD_AGREEMENT_KNOWLEDGE_SERVICE =
  "lifeops_household_agreement_knowledge";

interface AgreementOcrService {
  describe(input: {
    displayId: string;
    sourceX: number;
    sourceY: number;
    pngBytes: Uint8Array;
  }): Promise<{ blocks: ReadonlyArray<{ text: string }> }>;
}

async function resolveAgreementOcr(): Promise<AgreementOcrService | null> {
  const specifier: string = "@elizaos/plugin-vision/ocr-with-coords";
  try {
    const module = (await import(specifier)) as {
      getOcrWithCoordsService?: () => AgreementOcrService | null;
    };
    return module.getOcrWithCoordsService?.() ?? null;
  } catch {
    // error-policy:J4 OCR is an optional enrichment; strict rendered-page
    // IMAGE_DESCRIPTION transcription remains required and visible.
    return null;
  }
}

export type AgreementObligationStatus = "proposed" | "approved" | "rejected";
export type KnowledgePinTargetType = "agent" | "chat";

export interface ParentingAgreementArtifact {
  id: string;
  agentId: string;
  householdId: string;
  agreementKey: string;
  version: number;
  supersedesArtifactId: string | null;
  title: string;
  originalFilename: string;
  documentId: string;
  mediaUrl: string;
  mediaFileName: string;
  contentSha256: string;
  mimeType: string;
  byteSize: number;
  pageCount: number;
  uploadedByEntityId: string;
  createdAt: string;
}

export interface ParentingAgreementObligation {
  id: string;
  agentId: string;
  artifactId: string;
  title: string;
  obligationText: string;
  pageStart: number;
  pageEnd: number;
  citationText: string;
  status: AgreementObligationStatus;
  proposedByEntityId: string;
  decidedByEntityId: string | null;
  decisionReason: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HouseholdKnowledgePin {
  id: string;
  agentId: string;
  artifactId: string;
  targetType: KnowledgePinTargetType;
  targetId: string;
  pinnedByEntityId: string;
  pinnedAt: string;
  unpinnedAt: string | null;
}

export interface HouseholdKnowledgeGrant {
  id: string;
  agentId: string;
  householdId: string;
  artifactId: string;
  principalEntityId: string;
  householdGrantId: string;
  issuedByEntityId: string;
  revokedAt: string | null;
  revokedByEntityId: string | null;
  revocationReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ParentingAgreementView {
  artifact: ParentingAgreementArtifact;
  obligations: ParentingAgreementObligation[];
}

/** Guest-safe source metadata. Permanent byte capabilities and owner internals are excluded. */
export type ParentingAgreementGuestArtifact = Pick<
  ParentingAgreementArtifact,
  | "id"
  | "version"
  | "title"
  | "originalFilename"
  | "mimeType"
  | "byteSize"
  | "pageCount"
  | "createdAt"
>;

export interface ParentingAgreementGuestView {
  artifact: ParentingAgreementGuestArtifact;
  obligations: ParentingAgreementGuestObligation[];
}

export type ParentingAgreementGuestObligation = Pick<
  ParentingAgreementObligation,
  | "id"
  | "title"
  | "obligationText"
  | "pageStart"
  | "pageEnd"
  | "citationText"
  | "status"
  | "decidedAt"
>;

export interface AgreementGuestGrantPreview {
  allowed: boolean;
  artifactId: string;
  principalEntityId: string;
  householdGrantId: string;
  effects: readonly ["read_artifact_metadata", "read_approved_obligations"];
  exclusions: readonly [
    "read_proposed_or_rejected_obligations",
    "mutate_agreement",
    "inherit_access_from_pin",
  ];
  denial: { code: string; message: string } | null;
}

type AgreementKnowledgeErrorCode =
  | "AGREEMENT_ACCESS_DENIED"
  | "AGREEMENT_ARTIFACT_NOT_FOUND"
  | "AGREEMENT_DUPLICATE_CONTENT"
  | "AGREEMENT_INVALID_CONTRACT"
  | "AGREEMENT_OBLIGATION_CONFLICT"
  | "AGREEMENT_STORAGE_UNAVAILABLE";

export class AgreementKnowledgeError extends ElizaError {
  override readonly name = "AgreementKnowledgeError";

  constructor(
    message: string,
    code: AgreementKnowledgeErrorCode,
    context?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message, {
      code,
      context,
      cause,
      severity: code === "AGREEMENT_INVALID_CONTRACT" ? "fatal" : "ephemeral",
    });
  }
}

function requiredText(value: unknown, field: string): string {
  const text = toText(value).trim();
  if (!text) {
    throw new AgreementKnowledgeError(
      `Persisted agreement row is missing ${field}`,
      "AGREEMENT_INVALID_CONTRACT",
      { field },
    );
  }
  return text;
}

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return toText(value);
}

function positiveInteger(value: unknown, field: string): number {
  const number = toNumber(value, Number.NaN);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new AgreementKnowledgeError(
      `Persisted agreement row has invalid ${field}`,
      "AGREEMENT_INVALID_CONTRACT",
      { field, value: toText(value) },
    );
  }
  return number;
}

function obligationStatus(value: unknown): AgreementObligationStatus {
  if (value === "proposed" || value === "approved" || value === "rejected") {
    return value;
  }
  throw new AgreementKnowledgeError(
    "Persisted agreement obligation has an invalid status",
    "AGREEMENT_INVALID_CONTRACT",
    { status: toText(value) },
  );
}

function artifactFromRow(
  row: Record<string, unknown>,
): ParentingAgreementArtifact {
  return {
    id: requiredText(row.id, "id"),
    agentId: requiredText(row.agent_id, "agentId"),
    householdId: requiredText(row.household_id, "householdId"),
    agreementKey: requiredText(row.agreement_key, "agreementKey"),
    version: positiveInteger(row.version, "version"),
    supersedesArtifactId: optionalText(row.supersedes_artifact_id),
    title: requiredText(row.title, "title"),
    originalFilename: requiredText(row.original_filename, "originalFilename"),
    documentId: requiredText(row.document_id, "documentId"),
    mediaUrl: requiredText(row.media_url, "mediaUrl"),
    mediaFileName: requiredText(row.media_file_name, "mediaFileName"),
    contentSha256: requiredText(row.content_sha256, "contentSha256"),
    mimeType: requiredText(row.mime_type, "mimeType"),
    byteSize: positiveInteger(row.byte_size, "byteSize"),
    pageCount: positiveInteger(row.page_count, "pageCount"),
    uploadedByEntityId: requiredText(
      row.uploaded_by_entity_id,
      "uploadedByEntityId",
    ),
    createdAt: requiredText(row.created_at, "createdAt"),
  };
}

function obligationFromRow(
  row: Record<string, unknown>,
): ParentingAgreementObligation {
  return {
    id: requiredText(row.id, "id"),
    agentId: requiredText(row.agent_id, "agentId"),
    artifactId: requiredText(row.artifact_id, "artifactId"),
    title: requiredText(row.title, "title"),
    obligationText: requiredText(row.obligation_text, "obligationText"),
    pageStart: positiveInteger(row.page_start, "pageStart"),
    pageEnd: positiveInteger(row.page_end, "pageEnd"),
    citationText: requiredText(row.citation_text, "citationText"),
    status: obligationStatus(row.status),
    proposedByEntityId: requiredText(
      row.proposed_by_entity_id,
      "proposedByEntityId",
    ),
    decidedByEntityId: optionalText(row.decided_by_entity_id),
    decisionReason: optionalText(row.decision_reason),
    decidedAt: optionalText(row.decided_at),
    createdAt: requiredText(row.created_at, "createdAt"),
    updatedAt: requiredText(row.updated_at, "updatedAt"),
  };
}

function pinFromRow(row: Record<string, unknown>): HouseholdKnowledgePin {
  const targetType = requiredText(row.target_type, "targetType");
  if (targetType !== "agent" && targetType !== "chat") {
    throw new AgreementKnowledgeError(
      "Persisted knowledge pin has an invalid target type",
      "AGREEMENT_INVALID_CONTRACT",
      { targetType },
    );
  }
  return {
    id: requiredText(row.id, "id"),
    agentId: requiredText(row.agent_id, "agentId"),
    artifactId: requiredText(row.artifact_id, "artifactId"),
    targetType,
    targetId: requiredText(row.target_id, "targetId"),
    pinnedByEntityId: requiredText(row.pinned_by_entity_id, "pinnedByEntityId"),
    pinnedAt: requiredText(row.pinned_at, "pinnedAt"),
    unpinnedAt: optionalText(row.unpinned_at),
  };
}

function grantFromRow(row: Record<string, unknown>): HouseholdKnowledgeGrant {
  return {
    id: requiredText(row.id, "id"),
    agentId: requiredText(row.agent_id, "agentId"),
    householdId: requiredText(row.household_id, "householdId"),
    artifactId: requiredText(row.artifact_id, "artifactId"),
    principalEntityId: requiredText(
      row.principal_entity_id,
      "principalEntityId",
    ),
    householdGrantId: requiredText(row.household_grant_id, "householdGrantId"),
    issuedByEntityId: requiredText(row.issued_by_entity_id, "issuedByEntityId"),
    revokedAt: optionalText(row.revoked_at),
    revokedByEntityId: optionalText(row.revoked_by_entity_id),
    revocationReason: optionalText(row.revocation_reason),
    createdAt: requiredText(row.created_at, "createdAt"),
    updatedAt: requiredText(row.updated_at, "updatedAt"),
  };
}

export class AgreementKnowledgeRepository {
  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly agentId: string,
  ) {}

  async insertArtifact(input: Omit<ParentingAgreementArtifact, "version">) {
    return await withTransaction(this.runtime, async (tx) => {
      const previousRows = await executeRawSqlTx(
        tx,
        `SELECT * FROM app_lifeops.life_household_agreement_artifacts
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND household_id = ${sqlQuote(input.householdId)}
            AND agreement_key = ${sqlQuote(input.agreementKey)}
          ORDER BY version DESC
          LIMIT 1
          FOR UPDATE`,
      );
      const previous = previousRows[0]
        ? artifactFromRow(previousRows[0])
        : null;
      if (previous?.contentSha256 === input.contentSha256) {
        throw new AgreementKnowledgeError(
          "This agreement content is already the current immutable version",
          "AGREEMENT_DUPLICATE_CONTENT",
          { artifactId: previous.id, contentSha256: input.contentSha256 },
        );
      }
      const version = (previous?.version ?? 0) + 1;
      const rows = await executeRawSqlTx(
        tx,
        `INSERT INTO app_lifeops.life_household_agreement_artifacts (
           id, agent_id, household_id, agreement_key, version,
           supersedes_artifact_id, title, original_filename, document_id, media_url,
           media_file_name, content_sha256, mime_type, byte_size, page_count,
           uploaded_by_entity_id, created_at
         ) VALUES (
           ${sqlQuote(input.id)}, ${sqlQuote(this.agentId)},
           ${sqlQuote(input.householdId)}, ${sqlQuote(input.agreementKey)},
           ${sqlInteger(version)}, ${sqlText(previous?.id ?? null)},
           ${sqlQuote(input.title)}, ${sqlQuote(input.originalFilename)},
           ${sqlQuote(input.documentId)},
           ${sqlQuote(input.mediaUrl)}, ${sqlQuote(input.mediaFileName)},
           ${sqlQuote(input.contentSha256)}, ${sqlQuote(input.mimeType)},
           ${sqlInteger(input.byteSize)}, ${sqlInteger(input.pageCount)},
           ${sqlQuote(input.uploadedByEntityId)}, ${sqlQuote(input.createdAt)}
         ) RETURNING *`,
      );
      const row = rows[0];
      if (!row) {
        throw new AgreementKnowledgeError(
          "Agreement version insert returned no persisted row",
          "AGREEMENT_INVALID_CONTRACT",
        );
      }
      return artifactFromRow(row);
    });
  }

  async getArtifact(id: string): Promise<ParentingAgreementArtifact | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_household_agreement_artifacts
        WHERE agent_id = ${sqlQuote(this.agentId)} AND id = ${sqlQuote(id)}
        LIMIT 1`,
    );
    return rows[0] ? artifactFromRow(rows[0]) : null;
  }

  async listArtifacts(
    householdId?: string,
  ): Promise<ParentingAgreementArtifact[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_household_agreement_artifacts
        WHERE agent_id = ${sqlQuote(this.agentId)}
          ${householdId ? `AND household_id = ${sqlQuote(householdId)}` : ""}
        ORDER BY agreement_key ASC, version DESC, created_at DESC, id ASC`,
    );
    return rows.map(artifactFromRow);
  }

  async getArtifactByContent(input: {
    householdId: string;
    agreementKey: string;
    contentSha256: string;
  }): Promise<ParentingAgreementArtifact | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_household_agreement_artifacts
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND household_id = ${sqlQuote(input.householdId)}
          AND agreement_key = ${sqlQuote(input.agreementKey)}
          AND content_sha256 = ${sqlQuote(input.contentSha256)}
        LIMIT 1`,
    );
    return rows[0] ? artifactFromRow(rows[0]) : null;
  }

  async insertObligation(
    obligation: ParentingAgreementObligation,
  ): Promise<ParentingAgreementObligation> {
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_household_agreement_obligations (
         id, agent_id, artifact_id, title, obligation_text, page_start,
         page_end, citation_text, status, proposed_by_entity_id,
         decided_by_entity_id, decision_reason, decided_at, created_at, updated_at
       ) VALUES (
         ${sqlQuote(obligation.id)}, ${sqlQuote(this.agentId)},
         ${sqlQuote(obligation.artifactId)}, ${sqlQuote(obligation.title)},
         ${sqlQuote(obligation.obligationText)},
         ${sqlInteger(obligation.pageStart)}, ${sqlInteger(obligation.pageEnd)},
         ${sqlQuote(obligation.citationText)}, 'proposed',
         ${sqlQuote(obligation.proposedByEntityId)}, NULL, NULL, NULL,
         ${sqlQuote(obligation.createdAt)}, ${sqlQuote(obligation.updatedAt)}
       ) RETURNING *`,
    );
    const row = rows[0];
    if (!row) {
      throw new AgreementKnowledgeError(
        "Agreement obligation insert returned no persisted row",
        "AGREEMENT_INVALID_CONTRACT",
      );
    }
    return obligationFromRow(row);
  }

  async decideObligation(input: {
    obligationId: string;
    status: Exclude<AgreementObligationStatus, "proposed">;
    decidedByEntityId: string;
    decisionReason: string;
    decidedAt: string;
  }): Promise<ParentingAgreementObligation> {
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_household_agreement_obligations
          SET status = ${sqlQuote(input.status)},
              decided_by_entity_id = ${sqlQuote(input.decidedByEntityId)},
              decision_reason = ${sqlQuote(input.decisionReason)},
              decided_at = ${sqlQuote(input.decidedAt)},
              updated_at = ${sqlQuote(input.decidedAt)}
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND id = ${sqlQuote(input.obligationId)}
          AND status = 'proposed'
      RETURNING *`,
    );
    const row = rows[0];
    if (!row) {
      throw new AgreementKnowledgeError(
        "Obligation is missing or has already received a final decision",
        "AGREEMENT_OBLIGATION_CONFLICT",
        { obligationId: input.obligationId },
      );
    }
    return obligationFromRow(row);
  }

  async listObligations(
    artifactId: string,
  ): Promise<ParentingAgreementObligation[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_household_agreement_obligations
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND artifact_id = ${sqlQuote(artifactId)}
        ORDER BY page_start ASC, page_end ASC, created_at ASC, id ASC`,
    );
    return rows.map(obligationFromRow);
  }

  async listApprovedObligations(): Promise<ParentingAgreementObligation[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_household_agreement_obligations
        WHERE agent_id = ${sqlQuote(this.agentId)} AND status = 'approved'
        ORDER BY updated_at ASC, id ASC`,
    );
    return rows.map(obligationFromRow);
  }

  async setPin(input: {
    artifactId: string;
    targetType: KnowledgePinTargetType;
    targetId: string;
    pinnedByEntityId: string;
    pinnedAt: string;
  }): Promise<HouseholdKnowledgePin> {
    const id = `hkpin_${crypto.randomUUID()}`;
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_household_knowledge_pins (
         id, agent_id, artifact_id, target_type, target_id,
         pinned_by_entity_id, pinned_at, unpinned_at
       ) VALUES (
         ${sqlQuote(id)}, ${sqlQuote(this.agentId)},
         ${sqlQuote(input.artifactId)}, ${sqlQuote(input.targetType)},
         ${sqlQuote(input.targetId)}, ${sqlQuote(input.pinnedByEntityId)},
         ${sqlQuote(input.pinnedAt)}, NULL
       ) ON CONFLICT (agent_id, artifact_id, target_type, target_id)
       DO UPDATE SET pinned_by_entity_id = EXCLUDED.pinned_by_entity_id,
                     pinned_at = EXCLUDED.pinned_at,
                     unpinned_at = NULL
       RETURNING *`,
    );
    const row = rows[0];
    if (!row) {
      throw new AgreementKnowledgeError(
        "Knowledge pin insert returned no persisted row",
        "AGREEMENT_INVALID_CONTRACT",
      );
    }
    return pinFromRow(row);
  }

  async listPins(artifactId: string): Promise<HouseholdKnowledgePin[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_household_knowledge_pins
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND artifact_id = ${sqlQuote(artifactId)}
          AND unpinned_at IS NULL
        ORDER BY pinned_at ASC, id ASC`,
    );
    return rows.map(pinFromRow);
  }

  async listActivePinsForTargets(
    targets: ReadonlyArray<{
      targetType: KnowledgePinTargetType;
      targetId: string;
    }>,
  ): Promise<HouseholdKnowledgePin[]> {
    if (targets.length === 0) return [];
    const targetSql = targets
      .map(
        (target) =>
          `(target_type = ${sqlQuote(target.targetType)} AND target_id = ${sqlQuote(target.targetId)})`,
      )
      .join(" OR ");
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_household_knowledge_pins
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND unpinned_at IS NULL
          AND (${targetSql})
        ORDER BY pinned_at ASC, id ASC`,
    );
    return rows.map(pinFromRow);
  }

  async removePin(input: {
    pinId: string;
    unpinnedAt: string;
  }): Promise<HouseholdKnowledgePin> {
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_household_knowledge_pins
          SET unpinned_at = ${sqlQuote(input.unpinnedAt)}
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND id = ${sqlQuote(input.pinId)}
          AND unpinned_at IS NULL
      RETURNING *`,
    );
    const row = rows[0];
    if (!row) {
      throw new AgreementKnowledgeError(
        "Knowledge pin is missing or already inactive",
        "AGREEMENT_INVALID_CONTRACT",
        { pinId: input.pinId },
      );
    }
    return pinFromRow(row);
  }

  async upsertGrant(input: HouseholdKnowledgeGrant) {
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_household_knowledge_grants (
         id, agent_id, household_id, artifact_id, principal_entity_id,
         household_grant_id, issued_by_entity_id, revoked_at,
         revoked_by_entity_id, revocation_reason, created_at, updated_at
       ) VALUES (
         ${sqlQuote(input.id)}, ${sqlQuote(this.agentId)},
         ${sqlQuote(input.householdId)}, ${sqlQuote(input.artifactId)},
         ${sqlQuote(input.principalEntityId)},
         ${sqlQuote(input.householdGrantId)},
         ${sqlQuote(input.issuedByEntityId)}, NULL, NULL, NULL,
         ${sqlQuote(input.createdAt)}, ${sqlQuote(input.updatedAt)}
       ) ON CONFLICT (agent_id, artifact_id, principal_entity_id)
       DO UPDATE SET household_grant_id = EXCLUDED.household_grant_id,
                     issued_by_entity_id = EXCLUDED.issued_by_entity_id,
                     revoked_at = NULL,
                     revoked_by_entity_id = NULL,
                     revocation_reason = NULL,
                     updated_at = EXCLUDED.updated_at
       RETURNING *`,
    );
    const row = rows[0];
    if (!row) {
      throw new AgreementKnowledgeError(
        "Knowledge grant insert returned no persisted row",
        "AGREEMENT_INVALID_CONTRACT",
      );
    }
    return grantFromRow(row);
  }

  async listGrants(
    artifactId: string,
    principalEntityId: string,
  ): Promise<HouseholdKnowledgeGrant[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_household_knowledge_grants
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND artifact_id = ${sqlQuote(artifactId)}
          AND principal_entity_id = ${sqlQuote(principalEntityId)}
        ORDER BY created_at ASC, id ASC`,
    );
    return rows.map(grantFromRow);
  }

  async listArtifactGrants(
    artifactId: string,
  ): Promise<HouseholdKnowledgeGrant[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_household_knowledge_grants
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND artifact_id = ${sqlQuote(artifactId)}
        ORDER BY created_at ASC, id ASC`,
    );
    return rows.map(grantFromRow);
  }

  async revokeGrant(input: {
    grantId: string;
    revokedByEntityId: string;
    reason: string;
    revokedAt: string;
  }): Promise<HouseholdKnowledgeGrant> {
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_household_knowledge_grants
          SET revoked_at = ${sqlQuote(input.revokedAt)},
              revoked_by_entity_id = ${sqlQuote(input.revokedByEntityId)},
              revocation_reason = ${sqlQuote(input.reason)},
              updated_at = ${sqlQuote(input.revokedAt)}
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND id = ${sqlQuote(input.grantId)}
          AND revoked_at IS NULL
      RETURNING *`,
    );
    const row = rows[0];
    if (!row) {
      throw new AgreementKnowledgeError(
        "Knowledge grant is missing or already revoked",
        "AGREEMENT_ACCESS_DENIED",
        { grantId: input.grantId },
      );
    }
    return grantFromRow(row);
  }
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new AgreementKnowledgeError(
      `${field} is required`,
      "AGREEMENT_INVALID_CONTRACT",
      { field },
    );
  }
  return normalized;
}

function guestArtifactProjection(
  artifact: ParentingAgreementArtifact,
): ParentingAgreementGuestArtifact {
  return {
    id: artifact.id,
    version: artifact.version,
    title: artifact.title,
    originalFilename: artifact.originalFilename,
    mimeType: artifact.mimeType,
    byteSize: artifact.byteSize,
    pageCount: artifact.pageCount,
    createdAt: artifact.createdAt,
  };
}

function guestObligationProjection(
  obligation: ParentingAgreementObligation,
): ParentingAgreementGuestObligation {
  return {
    id: obligation.id,
    title: obligation.title,
    obligationText: obligation.obligationText,
    pageStart: obligation.pageStart,
    pageEnd: obligation.pageEnd,
    citationText: obligation.citationText,
    status: obligation.status,
    decidedAt: obligation.decidedAt,
  };
}

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AgreementKnowledgeError(
      `${field} must be a positive integer`,
      "AGREEMENT_INVALID_CONTRACT",
      { field, value },
    );
  }
  return value;
}

export class AgreementKnowledgeService {
  private readonly now: () => Date;

  constructor(
    private readonly deps: {
      runtime: IAgentRuntime;
      agentId: string;
      entityStore: EntityStore;
      household: HouseholdCoordinationService;
      repository: AgreementKnowledgeRepository;
      fileStorage: () => IFileStorageService | null;
      documents: () => DocumentService | null;
      pdf: () => PdfService | null;
      now?: () => Date;
    },
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  private requireOwner(actorEntityId: string): void {
    if (actorEntityId !== SELF_ENTITY_ID) {
      throw new AgreementKnowledgeError(
        "Only the owner may mutate parenting-agreement knowledge",
        "AGREEMENT_ACCESS_DENIED",
        { actorEntityId },
      );
    }
  }

  listApprovedObligations(): Promise<ParentingAgreementObligation[]> {
    return this.deps.repository.listApprovedObligations();
  }

  private requireOwnerOrAgent(actorEntityId: string): void {
    if (
      actorEntityId !== SELF_ENTITY_ID &&
      actorEntityId !== this.deps.agentId
    ) {
      throw new AgreementKnowledgeError(
        "Only the owner or this agent may propose agreement obligations",
        "AGREEMENT_ACCESS_DENIED",
        { actorEntityId },
      );
    }
  }

  private async requireArtifact(id: string) {
    const artifact = await this.deps.repository.getArtifact(
      normalizeHouseholdIdentifier(id, "artifactId"),
    );
    if (!artifact) {
      throw new AgreementKnowledgeError(
        "Parenting-agreement artifact was not found",
        "AGREEMENT_ARTIFACT_NOT_FOUND",
        { artifactId: id },
      );
    }
    return artifact;
  }

  async listOwnerAgreements(input: {
    ownerEntityId: string;
    householdId?: string;
  }): Promise<ParentingAgreementView[]> {
    this.requireOwner(input.ownerEntityId);
    const householdId = input.householdId
      ? normalizeHouseholdIdentifier(input.householdId, "householdId")
      : undefined;
    const artifacts = await this.deps.repository.listArtifacts(householdId);
    return await Promise.all(
      artifacts.map(async (artifact) => ({
        artifact,
        obligations: await this.deps.repository.listObligations(artifact.id),
      })),
    );
  }

  async createAgreementVersion(input: {
    householdId?: string;
    agreementKey: string;
    title: string;
    originalFilename: string;
    mimeType: string;
    bytes: Buffer | Uint8Array;
    uploadedByEntityId: string;
  }): Promise<ParentingAgreementArtifact> {
    this.requireOwner(input.uploadedByEntityId);
    if (input.mimeType.trim().toLowerCase() !== "application/pdf") {
      throw new AgreementKnowledgeError(
        "Parenting agreements must be uploaded as PDF bytes",
        "AGREEMENT_INVALID_CONTRACT",
        { mimeType: input.mimeType },
      );
    }
    if (input.bytes.byteLength < 1) {
      throw new AgreementKnowledgeError(
        "Parenting agreement PDF must not be empty",
        "AGREEMENT_INVALID_CONTRACT",
      );
    }
    const bytes = Buffer.from(input.bytes);
    if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new AgreementKnowledgeError(
        "Parenting agreement bytes do not have a PDF signature",
        "AGREEMENT_INVALID_CONTRACT",
      );
    }
    const householdId = normalizeHouseholdIdentifier(
      input.householdId ?? DEFAULT_HOUSEHOLD_ID,
      "householdId",
    );
    const agreementKey = nonEmpty(input.agreementKey, "agreementKey");
    const title = nonEmpty(input.title, "title");
    const originalFilename = nonEmpty(
      input.originalFilename,
      "originalFilename",
    );
    const expectedSha256 = crypto
      .createHash("sha256")
      .update(bytes)
      .digest("hex");
    const existing = await this.deps.repository.getArtifactByContent({
      householdId,
      agreementKey,
      contentSha256: expectedSha256,
    });
    if (existing) {
      throw new AgreementKnowledgeError(
        "This agreement content already exists as an immutable version",
        "AGREEMENT_DUPLICATE_CONTENT",
        { artifactId: existing.id, contentSha256: expectedSha256 },
      );
    }
    const fileStorage = this.deps.fileStorage();
    const documents = this.deps.documents();
    const pdf = this.deps.pdf();
    if (!fileStorage || !documents || !pdf) {
      throw new AgreementKnowledgeError(
        "The runtime file-storage, document, or PDF service is unavailable",
        "AGREEMENT_STORAGE_UNAVAILABLE",
        {
          fileStorage: Boolean(fileStorage),
          documents: Boolean(documents),
          pdf: Boolean(pdf),
        },
      );
    }
    let extracted: PdfCompleteDocument;
    try {
      const ocr = await resolveAgreementOcr();
      extracted = await pdf.extractCompleteDocument(bytes, {
        ocrPage: ocr
          ? async ({ pageNumber, pngBytes }) => {
              const result = await ocr.describe({
                displayId: `agreement-pdf-page-${pageNumber}`,
                sourceX: 0,
                sourceY: 0,
                pngBytes,
              });
              return result.blocks.map((block) => block.text).join("\n");
            }
          : undefined,
      });
    } catch (error) {
      throw new AgreementKnowledgeError(
        `The complete parenting-agreement PDF could not be extracted: ${error instanceof Error ? error.message : String(error)}`,
        "AGREEMENT_INVALID_CONTRACT",
        undefined,
        error,
      );
    }
    const pageCount = extracted.pageCount;
    const artifactId = `hag_${crypto.randomUUID()}`;
    const stored = await fileStorage.storePrivate(bytes, "application/pdf");
    if (
      stored.hash !== expectedSha256 ||
      !stored.fileName.startsWith(`${expectedSha256}.`) ||
      stored.size !== bytes.byteLength
    ) {
      throw new AgreementKnowledgeError(
        "File storage returned metadata that does not match the agreement bytes",
        "AGREEMENT_INVALID_CONTRACT",
        { expectedSha256, storedHash: stored.hash },
      );
    }
    const document = await documents.addDocument({
      agentId: this.deps.agentId as UUID,
      worldId: this.deps.agentId as UUID,
      roomId: this.deps.agentId as UUID,
      entityId: this.deps.agentId as UUID,
      clientDocumentId: "" as UUID,
      contentType: "text/plain",
      originalFilename: `${stored.hash}.txt`,
      content: [
        `Parenting agreement: ${title}`,
        `Source PDF: ${originalFilename}`,
        `Content SHA-256: ${stored.hash}`,
        `Pages: ${pageCount}`,
        "",
        extracted.text,
        "",
        "Agreement obligations are inactive until the owner approves their page-cited review records.",
      ].join("\n"),
      scope: "owner-private",
      addedBy: this.deps.agentId as UUID,
      addedByRole: "RUNTIME",
      addedFrom: "lifeops",
      pinned: false,
      metadata: {
        source: "lifeops.parenting-agreement",
        title,
        originalFilename,
        contentType: "application/pdf",
        mediaUrl: `/api/lifeops/agreements/${artifactId}/download`,
        mediaHash: stored.hash,
        mediaFileName: stored.fileName,
        agreementKey,
        householdId,
      },
    });
    return await this.deps.repository.insertArtifact({
      id: artifactId,
      agentId: this.deps.agentId,
      householdId,
      agreementKey,
      supersedesArtifactId: null,
      title,
      originalFilename,
      documentId: document.storedDocumentMemoryId,
      mediaUrl: `/api/lifeops/agreements/${artifactId}/download`,
      mediaFileName: stored.fileName,
      contentSha256: stored.hash,
      mimeType: stored.mimeType,
      byteSize: stored.size,
      pageCount,
      uploadedByEntityId: input.uploadedByEntityId,
      createdAt: this.now().toISOString(),
    });
  }

  async readOwnerPdf(input: {
    artifactId: string;
    ownerEntityId: string;
  }): Promise<{ bytes: Buffer; mimeType: string; fileName: string }> {
    this.requireOwner(input.ownerEntityId);
    const artifact = await this.requireArtifact(input.artifactId);
    const fileStorage = this.deps.fileStorage();
    if (!fileStorage) {
      throw new AgreementKnowledgeError(
        "The runtime private file-storage service is unavailable",
        "AGREEMENT_STORAGE_UNAVAILABLE",
      );
    }
    const bytes = await fileStorage.readPrivate(artifact.mediaFileName);
    if (!bytes) {
      throw new AgreementKnowledgeError(
        "The immutable parenting-agreement PDF is unavailable",
        "AGREEMENT_STORAGE_UNAVAILABLE",
        { artifactId: artifact.id },
      );
    }
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    if (hash !== artifact.contentSha256 || bytes.length !== artifact.byteSize) {
      throw new AgreementKnowledgeError(
        "The immutable parenting-agreement PDF failed integrity verification",
        "AGREEMENT_INVALID_CONTRACT",
        { artifactId: artifact.id },
      );
    }
    return {
      bytes,
      mimeType: artifact.mimeType,
      fileName: artifact.originalFilename,
    };
  }

  async proposeObligation(input: {
    artifactId: string;
    title: string;
    obligationText: string;
    pageStart: number;
    pageEnd?: number;
    citationText: string;
    proposedByEntityId: string;
  }): Promise<ParentingAgreementObligation> {
    this.requireOwnerOrAgent(input.proposedByEntityId);
    const artifact = await this.requireArtifact(input.artifactId);
    const pageStart = requirePositiveInteger(input.pageStart, "pageStart");
    const pageEnd = requirePositiveInteger(
      input.pageEnd ?? pageStart,
      "pageEnd",
    );
    if (pageEnd < pageStart || pageEnd > artifact.pageCount) {
      throw new AgreementKnowledgeError(
        "Obligation citation pages must be ordered and inside the source PDF",
        "AGREEMENT_INVALID_CONTRACT",
        { pageStart, pageEnd, pageCount: artifact.pageCount },
      );
    }
    const now = this.now().toISOString();
    return await this.deps.repository.insertObligation({
      id: `haob_${crypto.randomUUID()}`,
      agentId: this.deps.agentId,
      artifactId: artifact.id,
      title: nonEmpty(input.title, "title"),
      obligationText: nonEmpty(input.obligationText, "obligationText"),
      pageStart,
      pageEnd,
      citationText: nonEmpty(input.citationText, "citationText"),
      status: "proposed",
      proposedByEntityId: input.proposedByEntityId,
      decidedByEntityId: null,
      decisionReason: null,
      decidedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  async decideObligation(input: {
    obligationId: string;
    decision: "approve" | "reject";
    decidedByEntityId: string;
    reason: string;
  }): Promise<ParentingAgreementObligation> {
    this.requireOwner(input.decidedByEntityId);
    return await this.deps.repository.decideObligation({
      obligationId: normalizeHouseholdIdentifier(
        input.obligationId,
        "obligationId",
      ),
      status: input.decision === "approve" ? "approved" : "rejected",
      decidedByEntityId: input.decidedByEntityId,
      decisionReason: nonEmpty(input.reason, "reason"),
      decidedAt: this.now().toISOString(),
    });
  }

  async pin(input: {
    artifactId: string;
    targetType: KnowledgePinTargetType;
    targetId: string;
    pinnedByEntityId: string;
  }): Promise<HouseholdKnowledgePin> {
    this.requireOwner(input.pinnedByEntityId);
    const artifact = await this.requireArtifact(input.artifactId);
    return await this.deps.repository.setPin({
      artifactId: artifact.id,
      targetType: input.targetType,
      targetId: nonEmpty(input.targetId, "targetId"),
      pinnedByEntityId: input.pinnedByEntityId,
      pinnedAt: this.now().toISOString(),
    });
  }

  async listPins(input: {
    artifactId: string;
    ownerEntityId: string;
  }): Promise<HouseholdKnowledgePin[]> {
    this.requireOwner(input.ownerEntityId);
    const artifact = await this.requireArtifact(input.artifactId);
    return await this.deps.repository.listPins(artifact.id);
  }

  async unpin(input: {
    pinId: string;
    unpinnedByEntityId: string;
  }): Promise<HouseholdKnowledgePin> {
    this.requireOwner(input.unpinnedByEntityId);
    return await this.deps.repository.removePin({
      pinId: normalizeHouseholdIdentifier(input.pinId, "pinId"),
      unpinnedAt: this.now().toISOString(),
    });
  }

  async previewGuestRead(input: {
    artifactId: string;
    principalEntityId: string;
    householdGrantId: string;
    ownerEntityId: string;
  }): Promise<AgreementGuestGrantPreview> {
    this.requireOwner(input.ownerEntityId);
    const artifact = await this.requireArtifact(input.artifactId);
    const principalEntityId = normalizeHouseholdIdentifier(
      input.principalEntityId,
      "principalEntityId",
    );
    const householdGrantId = normalizeHouseholdIdentifier(
      input.householdGrantId,
      "householdGrantId",
    );
    const base = {
      artifactId: artifact.id,
      principalEntityId,
      householdGrantId,
      effects: ["read_artifact_metadata", "read_approved_obligations"] as const,
      exclusions: [
        "read_proposed_or_rejected_obligations",
        "mutate_agreement",
        "inherit_access_from_pin",
      ] as const,
    };
    const principal = await this.deps.entityStore.get(principalEntityId);
    if (!principal?.identities.some((identity) => identity.verified)) {
      return {
        ...base,
        allowed: false,
        denial: {
          code: "AGREEMENT_ACCESS_DENIED",
          message: "Guest requires a verified identity",
        },
      };
    }
    try {
      await this.deps.household.requireGrantActive({
        householdId: artifact.householdId,
        grantId: householdGrantId,
        principalEntityId,
        scope: "knowledge.read",
        at: this.now(),
      });
      return { ...base, allowed: true, denial: null };
    } catch (error) {
      if (!(error instanceof HouseholdCoordinationError)) throw error;
      return {
        ...base,
        allowed: false,
        denial: {
          code: "AGREEMENT_ACCESS_DENIED",
          message: error.message,
        },
      };
    }
  }

  async activePinnedContext(input: {
    ownerEntityId: string;
    roomId?: string;
  }): Promise<ParentingAgreementView[]> {
    this.requireOwner(input.ownerEntityId);
    const targets: Array<{
      targetType: KnowledgePinTargetType;
      targetId: string;
    }> = [{ targetType: "agent", targetId: this.deps.agentId }];
    if (input.roomId) {
      targets.push({
        targetType: "chat",
        targetId: normalizeHouseholdIdentifier(input.roomId, "roomId"),
      });
    }
    const pins = await this.deps.repository.listActivePinsForTargets(targets);
    const artifactIds = [...new Set(pins.map((pin) => pin.artifactId))];
    const views: ParentingAgreementView[] = [];
    for (const artifactId of artifactIds) {
      const artifact = await this.requireArtifact(artifactId);
      const obligations = (
        await this.deps.repository.listObligations(artifact.id)
      ).filter((obligation) => obligation.status === "approved");
      if (obligations.length > 0) views.push({ artifact, obligations });
    }
    return views;
  }

  /**
   * Resolve active pins through the requesting principal's current resource
   * grants. Owner callers retain the complete owner view; guests receive only
   * the safe projection from `readFor`, and a pin never turns a denial into
   * access.
   */
  async activePinnedContextForPrincipal(input: {
    principalEntityId: string;
    roomId?: string;
    at?: Date;
  }): Promise<Array<ParentingAgreementView | ParentingAgreementGuestView>> {
    const principalEntityId = normalizeHouseholdIdentifier(
      input.principalEntityId,
      "principalEntityId",
    );
    if (principalEntityId === SELF_ENTITY_ID) {
      return this.activePinnedContext({
        ownerEntityId: SELF_ENTITY_ID,
        ...(input.roomId ? { roomId: input.roomId } : {}),
      });
    }
    const targets: Array<{
      targetType: KnowledgePinTargetType;
      targetId: string;
    }> = [{ targetType: "agent", targetId: this.deps.agentId }];
    if (input.roomId) {
      targets.push({
        targetType: "chat",
        targetId: normalizeHouseholdIdentifier(input.roomId, "roomId"),
      });
    }
    const pins = await this.deps.repository.listActivePinsForTargets(targets);
    const artifactIds = [...new Set(pins.map((pin) => pin.artifactId))];
    const views: ParentingAgreementGuestView[] = [];
    for (const artifactId of artifactIds) {
      try {
        const view = await this.readFor({
          artifactId,
          principalEntityId,
          ...(input.at ? { at: input.at } : {}),
        });
        if ("contentSha256" in view.artifact) {
          throw new AgreementKnowledgeError(
            "Guest pin projection unexpectedly resolved owner knowledge",
            "AGREEMENT_ACCESS_DENIED",
            { artifactId, principalEntityId },
          );
        }
        views.push(view);
      } catch (error) {
        if (
          error instanceof AgreementKnowledgeError &&
          error.code === "AGREEMENT_ACCESS_DENIED"
        ) {
          // error-policy:J4 A pin is discovery metadata, never authorization.
          // Omit an inaccessible artifact while independently evaluating peers.
          continue;
        }
        throw error;
      }
    }
    return views;
  }

  async grantGuestRead(input: {
    artifactId: string;
    principalEntityId: string;
    householdGrantId: string;
    issuedByEntityId: string;
  }): Promise<HouseholdKnowledgeGrant> {
    this.requireOwner(input.issuedByEntityId);
    const artifact = await this.requireArtifact(input.artifactId);
    const principalEntityId = normalizeHouseholdIdentifier(
      input.principalEntityId,
      "principalEntityId",
    );
    const principal = await this.deps.entityStore.get(principalEntityId);
    if (!principal?.identities.some((identity) => identity.verified)) {
      throw new AgreementKnowledgeError(
        "Agreement guests require at least one verified identity",
        "AGREEMENT_ACCESS_DENIED",
        { principalEntityId },
      );
    }
    await this.deps.household.requireGrantActive({
      householdId: artifact.householdId,
      grantId: input.householdGrantId,
      principalEntityId,
      scope: "knowledge.read",
      at: this.now(),
    });
    const now = this.now().toISOString();
    return await this.deps.repository.upsertGrant({
      id: `hkgrant_${crypto.randomUUID()}`,
      agentId: this.deps.agentId,
      householdId: artifact.householdId,
      artifactId: artifact.id,
      principalEntityId,
      householdGrantId: input.householdGrantId,
      issuedByEntityId: input.issuedByEntityId,
      revokedAt: null,
      revokedByEntityId: null,
      revocationReason: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  /** Owner-only recipient ACL projection for downstream share drafts. */
  async listActiveGuestPrincipals(input: {
    artifactId: string;
    ownerEntityId: string;
    at?: Date;
  }): Promise<string[]> {
    this.requireOwner(input.ownerEntityId);
    const artifact = await this.requireArtifact(input.artifactId);
    const allowed: string[] = [];
    for (const grant of await this.deps.repository.listArtifactGrants(
      artifact.id,
    )) {
      if (grant.revokedAt) continue;
      try {
        await this.deps.household.requireGrantActive({
          householdId: artifact.householdId,
          grantId: grant.householdGrantId,
          principalEntityId: grant.principalEntityId,
          scope: "knowledge.read",
          at: input.at ?? this.now(),
        });
        allowed.push(grant.principalEntityId);
      } catch (error) {
        if (!(error instanceof HouseholdCoordinationError)) throw error;
        // error-policy:J4 inactive household grants are omitted from the
        // explicit downstream ACL instead of being presented as active.
      }
    }
    return [...new Set(allowed)].sort();
  }

  async revokeGuestRead(input: {
    grantId: string;
    revokedByEntityId: string;
    reason: string;
  }): Promise<HouseholdKnowledgeGrant> {
    this.requireOwner(input.revokedByEntityId);
    return await this.deps.repository.revokeGrant({
      grantId: normalizeHouseholdIdentifier(input.grantId, "grantId"),
      revokedByEntityId: input.revokedByEntityId,
      reason: nonEmpty(input.reason, "reason"),
      revokedAt: this.now().toISOString(),
    });
  }

  async readFor(input: {
    artifactId: string;
    principalEntityId: string;
    at?: Date;
  }): Promise<ParentingAgreementView | ParentingAgreementGuestView> {
    const artifact = await this.requireArtifact(input.artifactId);
    const principalEntityId = normalizeHouseholdIdentifier(
      input.principalEntityId,
      "principalEntityId",
    );
    const obligations = await this.deps.repository.listObligations(artifact.id);
    if (principalEntityId === SELF_ENTITY_ID) {
      return { artifact, obligations };
    }
    const grants = await this.deps.repository.listGrants(
      artifact.id,
      principalEntityId,
    );
    for (const grant of grants) {
      if (grant.revokedAt) continue;
      try {
        await this.deps.household.requireGrantActive({
          householdId: artifact.householdId,
          grantId: grant.householdGrantId,
          principalEntityId,
          scope: "knowledge.read",
          at: input.at ?? this.now(),
        });
        return {
          artifact: guestArtifactProjection(artifact),
          obligations: obligations
            .filter((obligation) => obligation.status === "approved")
            .map(guestObligationProjection),
        };
      } catch (error) {
        if (!(error instanceof HouseholdCoordinationError)) throw error;
        // error-policy:J4 A stale resource binding is an explicit denied read;
        // another independently active binding may still authorize the same
        // principal, so evaluate every exact candidate before failing closed.
      }
    }
    throw new AgreementKnowledgeError(
      "The principal has no active grant for this agreement version",
      "AGREEMENT_ACCESS_DENIED",
      { artifactId: artifact.id, principalEntityId },
    );
  }
}

export function createAgreementKnowledgeService(
  runtime: IAgentRuntime,
  now?: () => Date,
): AgreementKnowledgeService {
  const graph = resolveKnowledgeGraphService(runtime);
  const household = getHouseholdCoordinationService(runtime);
  if (!graph || !household) {
    throw new AgreementKnowledgeError(
      "Agreement knowledge requires graph and household services",
      "AGREEMENT_STORAGE_UNAVAILABLE",
      {
        graph: Boolean(graph),
        household: Boolean(household),
      },
    );
  }
  return new AgreementKnowledgeService({
    runtime,
    agentId: runtime.agentId,
    entityStore: graph.getEntityStore(runtime.agentId),
    household,
    repository: new AgreementKnowledgeRepository(runtime, runtime.agentId),
    fileStorage: () =>
      runtime.getService<IFileStorageService>(ServiceType.REMOTE_FILES),
    documents: () =>
      runtime.getService<DocumentService>(DocumentService.serviceType),
    pdf: () => runtime.getService<PdfService>(ServiceType.PDF),
    now,
  });
}

export class AgreementKnowledgeRuntimeService extends Service {
  static override serviceType = HOUSEHOLD_AGREEMENT_KNOWLEDGE_SERVICE;
  override capabilityDescription =
    "Immutable parenting-agreement versions, reviewed citations, pins, and bounded guest reads";

  readonly agreements: AgreementKnowledgeService;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (!runtime) {
      throw new AgreementKnowledgeError(
        "AgreementKnowledgeRuntimeService requires a runtime",
        "AGREEMENT_INVALID_CONTRACT",
      );
    }
    this.agreements = createAgreementKnowledgeService(runtime);
  }

  static async start(runtime: IAgentRuntime) {
    await Promise.all([
      runtime.getServiceLoadPromise(KNOWLEDGE_GRAPH_SERVICE),
      runtime.getServiceLoadPromise(HOUSEHOLD_COORDINATION_SERVICE),
    ]);
    return new AgreementKnowledgeRuntimeService(runtime);
  }

  async stop(): Promise<void> {}
}

export function getAgreementKnowledgeService(
  runtime: IAgentRuntime,
): AgreementKnowledgeService | null {
  return (
    runtime.getService<AgreementKnowledgeRuntimeService>(
      HOUSEHOLD_AGREEMENT_KNOWLEDGE_SERVICE,
    )?.agreements ?? null
  );
}
