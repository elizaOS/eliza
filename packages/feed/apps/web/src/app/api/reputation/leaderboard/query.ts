import { z } from 'zod';

const ReputationLeaderboardQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  minGames: z.coerce.number().int().min(0).default(5),
  timeRange: z.enum(['all', 'daily', 'weekly', 'monthly']).default('all'),
});

export type ReputationLeaderboardQuery = z.infer<
  typeof ReputationLeaderboardQuerySchema
>;
export type ReputationTimeRange = ReputationLeaderboardQuery['timeRange'];

const TIME_RANGE_TO_MS: Record<Exclude<ReputationTimeRange, 'all'>, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

export function parseReputationLeaderboardQuery(
  searchParams: URLSearchParams
): ReputationLeaderboardQuery {
  return ReputationLeaderboardQuerySchema.parse({
    limit: searchParams.get('limit') ?? undefined,
    minGames: searchParams.get('minGames') ?? undefined,
    timeRange: searchParams.get('timeRange') ?? undefined,
  });
}

export function getReputationActivityCutoff(
  timeRange: ReputationTimeRange,
  now = new Date()
): Date | null {
  if (timeRange === 'all') {
    return null;
  }

  return new Date(now.getTime() - TIME_RANGE_TO_MS[timeRange]);
}
