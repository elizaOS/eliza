import {
  db,
  desc,
  eq,
  markets,
  questions,
  timeframedMarkets,
  users,
} from '@babylon/db';

export type PublicResolutionAudit = {
  resolution: boolean | null;
  resolvedAt: string | null;
  reviewStatus: string | null;
  confidence: number | null;
  description: string | null;
  proofUrl: string | null;
  resolvedBy: {
    id: string;
    displayName: string | null;
    username: string | null;
    kind: 'admin' | 'system';
  } | null;
};

export async function getPublicResolutionAudit(
  marketId: string
): Promise<PublicResolutionAudit | null> {
  const [[market], [question], [latestResolvedFrame]] = await Promise.all([
    db.select().from(markets).where(eq(markets.id, marketId)).limit(1),
    db.select().from(questions).where(eq(questions.id, marketId)).limit(1),
    db
      .select({ resolvedAt: timeframedMarkets.resolvedAt })
      .from(timeframedMarkets)
      .where(eq(timeframedMarkets.questionId, marketId))
      .orderBy(desc(timeframedMarkets.resolvedAt))
      .limit(1),
  ]);

  if (!market) {
    return null;
  }

  const reviewerId = question?.resolutionReviewedBy ?? null;
  const reviewedAt = question?.resolutionReviewedAt ?? null;
  const frameResolvedAt = latestResolvedFrame?.resolvedAt ?? null;
  const resolvedAt =
    reviewedAt ??
    frameResolvedAt ??
    (market.resolved ? market.updatedAt : null) ??
    null;

  let resolvedBy: PublicResolutionAudit['resolvedBy'] = null;

  if (reviewerId === 'system') {
    resolvedBy = {
      id: 'system',
      displayName: 'Babylon Resolution Engine',
      username: null,
      kind: 'system',
    };
  } else if (reviewerId) {
    const [reviewer] = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        username: users.username,
      })
      .from(users)
      .where(eq(users.id, reviewerId))
      .limit(1);

    if (reviewer) {
      resolvedBy = {
        id: reviewer.id,
        displayName: reviewer.displayName,
        username: reviewer.username,
        kind: 'admin',
      };
    }
  }

  return {
    resolution: market.resolution ?? null,
    resolvedAt: resolvedAt?.toISOString() ?? null,
    reviewStatus: question?.resolutionReviewStatus ?? null,
    confidence:
      typeof question?.resolutionConfidence === 'number'
        ? question.resolutionConfidence
        : null,
    description:
      question?.resolutionDescription ?? market.resolutionDescription ?? null,
    proofUrl: question?.resolutionProofUrl ?? market.resolutionProofUrl ?? null,
    resolvedBy,
  };
}
