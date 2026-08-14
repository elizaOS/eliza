/**
 * Commitment-audit domain for LifeOps. Reads the current agent's validated
 * active ledger, applies deterministic regret scoring, and projects only the
 * redacted fields allowed on the owner-facing service contract.
 */
import { buildCommitmentRegretAudit } from "../commitments/ledger.js";
import type { LifeOpsContext } from "../lifeops-context.js";
import type { LifeOpsCommitmentRegretAuditResponse } from "../service-mixin-commitments.js";

export class CommitmentsDomain {
  constructor(private readonly ctx: LifeOpsContext) {}

  async getCommitmentRegretAudit(input: {
    horizonDays: number;
    nowIso?: string;
  }): Promise<LifeOpsCommitmentRegretAuditResponse> {
    const generatedAt = input.nowIso ?? new Date().toISOString();
    const records = await this.ctx.repository.listCommitmentLedgerRecords(
      this.ctx.agentId(),
      { statuses: ["open", "tracked"] },
    );
    const audit = buildCommitmentRegretAudit(records, {
      nowIso: generatedAt,
      horizonDays: input.horizonDays,
    });
    return {
      generatedAt: audit.generatedAt,
      horizonDays: input.horizonDays,
      horizonEndAt: audit.horizonEndAt,
      items: audit.items.map(({ record, score, reasons }) => ({
        id: record.id,
        source: record.source,
        kind: record.kind,
        summary: record.summary,
        counterparty: record.counterparty,
        dueAt: record.dueAt,
        confidence: record.confidence,
        status: record.status,
        scheduledTaskId: record.scheduledTaskId,
        score,
        reasons,
      })),
    };
  }
}
