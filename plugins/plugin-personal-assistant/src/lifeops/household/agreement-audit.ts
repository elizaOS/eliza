/**
 * Commits agreement state transitions and their provenance to the canonical
 * LifeOps audit ledger in one SQL statement. The returned rows are the actual
 * persisted transition; an audit failure rolls back the mutation as well.
 */
import crypto from "node:crypto";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { sqlQuote, sqlText } from "../sql.js";

export type AgreementAuditKind =
  | "agreement_ingested"
  | "agreement_obligation_proposed"
  | "agreement_obligation_decided"
  | "agreement_pinned"
  | "agreement_unpinned"
  | "agreement_granted"
  | "agreement_revoked";

/** Wrap a repository-owned mutation ending in RETURNING *; never accept client SQL. */
export function agreementMutationSql(
  mutation: string,
  event: {
    agentId: string;
    kind: AgreementAuditKind;
    actorEntityId: string;
    createdAt: string;
    artifactRow?: boolean;
    extractionSha256?: string;
  },
): string {
  const artifact = event.artifactRow
    ? "SELECT changed.id, changed.version, changed.content_sha256"
    : `SELECT artifact.id, artifact.version, artifact.content_sha256
       FROM app_lifeops.life_household_agreement_artifacts AS artifact
       WHERE artifact.agent_id = ${sqlQuote(event.agentId)}
         AND artifact.id = changed.artifact_id`;
  // Scalar source lookups intentionally become NULL on a missing/foreign
  // artifact. The ledger's non-null owner_id then rejects the whole mutation.
  return `WITH changed AS (${mutation}), recorded AS (
    INSERT INTO app_lifeops.life_audit_events (
      id, agent_id, event_type, owner_type, owner_id, reason,
      inputs_json, decision_json, actor, created_at
    ) SELECT
      ${sqlQuote(`agreement_audit_${crypto.randomUUID()}`)},
      ${sqlQuote(event.agentId)}, ${sqlQuote(event.kind)},
      'parenting_agreement',
      (SELECT source.id FROM (${artifact}) AS source),
      ${sqlQuote(event.kind)},
      jsonb_build_object(
        'schemaVersion', 1,
        'actorEntityId', ${sqlQuote(event.actorEntityId)},
        'extractionSha256', ${sqlText(event.extractionSha256 ?? null)},
        'source', (SELECT to_jsonb(source) FROM (${artifact}) AS source)
      )::text,
      to_jsonb(changed)::text,
      ${sqlQuote(event.actorEntityId === SELF_ENTITY_ID ? "owner" : "agent")},
      ${sqlQuote(event.createdAt)}
    FROM changed
    RETURNING id
  ) SELECT changed.* FROM changed CROSS JOIN recorded`;
}
